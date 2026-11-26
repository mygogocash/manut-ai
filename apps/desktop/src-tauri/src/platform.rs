//! The two "which system is this" switches and the Windows console flag that several modules share.
//!
//! They lived in the Hermes bridge launcher and the `hermes auth` opener of Oh My Hermes. Manut AI starts neither,
//! so the launcher and the opener are gone, and what the rest of the shell still needs from them is kept here.

use std::process::Command;

/// Which install layout and path rules apply on this machine. Passed in so the Windows rules are tested on any host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Unix,
    Windows,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(windows) {
            Os::Windows
        } else {
            Os::Unix
        }
    }
}

/// Which desktop a system terminal is opened on. Passed in so every platform's argv is tested on any host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Desk {
    Mac,
    Windows,
    Linux,
}

impl Desk {
    pub fn current() -> Desk {
        if cfg!(target_os = "macos") {
            Desk::Mac
        } else if cfg!(windows) {
            Desk::Windows
        } else {
            Desk::Linux
        }
    }
}

/// A release build on Windows has no console of its own, so a console child would flash a terminal window.
/// `CREATE_NO_WINDOW` keeps it hidden; elsewhere this does nothing.
#[cfg(windows)]
pub(crate) fn no_console_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub(crate) fn no_console_window(_cmd: &mut Command) {}
