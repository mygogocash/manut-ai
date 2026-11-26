//! Computer use (item 82, docs/computer-use.md): the person's agent can look at and work the windows of any app on
//! this Mac when asked, as Orca's Computer Use does (`stablyai/orca`, MIT), and everything that changes something asks
//! first, once, through the chat's own card.
//!
//! - Settings › Computer reads the two permissions macOS keeps for this app, without asking for either ([`Status`],
//!   `computer_status`), and opens the right pane of System Settings for each (`computer_open`), which grants nothing
//!   by itself.
//! - A chat's Claude Code is handed an MCP server, this same program started as `manut --computer-mcp` (`mcp.rs`),
//!   and a skill that says how to use it (`SKILL.md`, from Orca's guide). The server relays each call to the shell
//!   over a socket only this user can open, which serves only this app's own program started under that chat's Claude
//!   Code, read from the kernel (`hub.rs`), and the shell does the looking and acting (`mac.rs`), so the permissions
//!   are the app's and every check is in one place (`room.rs`).
//! - Each call Claude Code asks permission for comes to the shell first (`tap.rs`): a look at an app the person allowed
//!   in this chat, or the list of apps, is answered at once; anything else is the chat's card, and only the person's
//!   Allow once lets that one call run, once.
//!
//! - A key the person sets (`snap.rs`, item 104) reads the front window of any app with the same reader and refusals,
//!   masks it, and opens a new chat whose box holds it, sent only when the person presses Send.
//!
//! Elsewhere than macOS there is no computer use: the commands say so and no chat is handed the tools.

pub mod hub;
pub mod keys;
pub mod mcp;
pub mod room;
pub mod snap;
pub mod tap;

#[cfg(test)]
pub mod stand;

#[cfg(target_os = "macos")]
pub mod mac;

use serde::Serialize;

/// The MCP server's name in Claude Code's configuration: its tools are `mcp__manut-computer__<tool>`.
pub const SERVER: &str = "manut-computer";

/// The two panes of System Settings the page opens, each a fixed address (the page names only the pane). These are the
/// addresses Orca opens for the same two permissions (`native/computer-use-macos/.../main.swift`,
/// `openAccessibilitySettings` and `openScreenRecordingSettings`; `src/main/ipc/developer-permissions`).
pub const ACCESSIBILITY_PANE: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
pub const SCREEN_PANE: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/// What Settings › Computer shows, read without asking the person or macOS for anything.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Computer use works here at all (the Mac app).
    pub mac: bool,
    /// macOS lets this app use accessibility: read windows' text and controls, and act in them.
    pub accessibility: bool,
    /// macOS lets this app capture the screen: pictures of windows.
    pub screen: bool,
    /// This copy is signed with a Developer ID (or by the App Store), so macOS keeps both permissions across updates.
    /// An ad hoc or unsigned build (0.1.1) is tied to its own code, and each update is asked again (TN3127).
    pub signed: bool,
}

/// The address of `pane`, or None for anything but the two panes.
pub fn pane_address(pane: &str) -> Option<&'static str> {
    match pane {
        "accessibility" => Some(ACCESSIBILITY_PANE),
        "screen" => Some(SCREEN_PANE),
        _ => None,
    }
}

/// Whether this running copy is signed by a certificate Apple issued (a Developer ID or the App Store), read from its
/// own signature: the code requirement `anchor apple generic` holds only then, and never for an ad hoc signature.
#[cfg(target_os = "macos")]
fn signed_by_apple() -> bool {
    use security_framework::os::macos::code_signing::{Flags, SecCode, SecRequirement};
    let Ok(req) = "anchor apple generic".parse::<SecRequirement>() else { return false };
    SecCode::for_self(Flags::NONE).and_then(|c| c.check_validity(Flags::NONE, &req)).is_ok()
}

/// Reads the two permissions and the signature. Nothing here can show a prompt: both reads are the ones Apple
/// documents as asking nothing.
pub fn status() -> Status {
    #[cfg(target_os = "macos")]
    {
        Status { mac: true, accessibility: mac::accessibility_granted(), screen: mac::screen_granted(), signed: signed_by_apple() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Status { mac: false, accessibility: false, screen: false, signed: false }
    }
}

/// Settings › Computer reads where things stand (each time it opens, on Re-check, and when the window comes back to the
/// front from System Settings).
#[tauri::command]
pub async fn computer_status() -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(status).await.map_err(|e| e.to_string())
}

/// Opens `pane` ("accessibility" or "screen") of System Settings › Privacy & Security, where the person turns Manut AI
/// on. Grants nothing: only the person can, there.
#[tauri::command]
pub async fn computer_open(pane: String) -> Result<(), String> {
    let address = pane_address(&pane).ok_or("not a pane computer use opens")?;
    if !cfg!(target_os = "macos") {
        return Err("Computer use is on the Mac only".into());
    }
    tauri_plugin_opener::open_url(address, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The page names a pane, never an address, and only the two panes open.
    #[test]
    fn opens_only_the_two_panes_of_system_settings() {
        assert_eq!(pane_address("accessibility"), Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"));
        assert_eq!(pane_address("screen"), Some("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"));
        for other in ["", "Accessibility", "microphone", "x-apple.systempreferences:com.apple.preference.security", "https://example.com", "screen "] {
            assert_eq!(pane_address(other), None, "{other}");
        }
    }

    /// Reading where things stand asks nothing: no function that prompts is named anywhere in computer use, and nothing
    /// asks macOS to grant anything (the two prompting calls, and Accessibility's prompt option). Only the person can
    /// grant either permission, in System Settings.
    #[test]
    fn reading_the_permissions_never_prompts() {
        let files = [include_str!("mod.rs"), include_str!("mac.rs"), include_str!("room.rs"), include_str!("hub.rs"), include_str!("tap.rs"), include_str!("mcp.rs"), include_str!("snap.rs")];
        for src in files {
            // the code, without the comments that name what is not here
            let code: String = src.split("#[cfg(test)]\nmod tests").next().unwrap().lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
            // and no event tap, which macOS lets run only with Input Monitoring or Accessibility asked for (the snapshot's
            // key is a Carbon hot key, snap.rs, which needs neither)
            for banned in ["AXIsProcessTrustedWithOptions", "kAXTrustedCheckOptionPrompt", "CGRequestScreenCaptureAccess", "AXMakeProcessTrusted", "tccutil", "SCShareableContent", "CGEventTapCreate", "CGRequestListenEventAccess"] {
                assert!(!code.contains(banned), "{banned}");
            }
        }
        let mac = include_str!("mac.rs");
        assert!(mac.contains("fn AXIsProcessTrusted() -> u8"));
        assert!(mac.contains("fn CGPreflightScreenCaptureAccess() -> bool"));
    }

    /// The signature is read from this very program: a test binary is never signed by a Developer ID, so it reads as
    /// one whose permissions an update would lose. (The two permission reads are not called here: they are the Mac's
    /// own, and the owner's steps check them.)
    #[cfg(target_os = "macos")]
    #[test]
    fn a_copy_not_signed_by_apple_reads_as_unsigned() {
        assert!(!signed_by_apple());
    }

    #[test]
    fn the_status_reaches_the_page_in_its_own_names() {
        let v = serde_json::to_value(Status { mac: true, accessibility: true, screen: false, signed: false }).unwrap();
        assert_eq!(v, serde_json::json!({"mac": true, "accessibility": true, "screen": false, "signed": false}));
    }

    /// What the app declares does not change for computer use: Apple documents no usage line for Accessibility or
    /// Screen capture (its list of protected resources has none), and the hardened runtime's resource-access
    /// entitlements cover neither (Apple's Hardened Runtime page), so `Info.plist` keeps voice's two lines and
    /// `Entitlements.plist` its one entitlement.
    #[test]
    fn declares_nothing_new_for_computer_use() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let info = plist::Value::from_file(dir.join("Info.plist")).unwrap();
        let mut keys: Vec<&String> = info.as_dictionary().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["NSMicrophoneUsageDescription", "NSSpeechRecognitionUsageDescription"]);
        let ent = plist::Value::from_file(dir.join("Entitlements.plist")).unwrap();
        let ent: Vec<&String> = ent.as_dictionary().unwrap().keys().collect();
        assert_eq!(ent, ["com.apple.security.device.audio-input"]);
    }
}
