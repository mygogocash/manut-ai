//! Item 103: other programs on this Mac reach the chats the person listed, through an MCP server that is this app's own
//! program (`docs/mcp-threads.md`, decisions in `docs/decisions/103-mcp-threads.md`).
//!
//! - `relay.rs`: `manut --threads-mcp`, the stdio MCP server another program starts from the address the person copied.
//! - `door.rs`: the app's one socket for it, in `~/.manut/threads`, and who may ask.
//! - Here: the switch, off by default and kept in `~/.manut/threads-mcp.json`; the page's side of the door, an app-wide
//!   event for each call (`threads-mcp-call`) and for each call that is gone (`threads-mcp-gone`); and the commands the
//!   page answers with.
//!
//! Slice 103a builds the shell's side alone. Until the page listens (`threads_mcp_listen`, slice 103b), a call is answered
//! that the window is not ready, so nothing reaches a chat.

pub mod door;
pub mod relay;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use serde::Serialize;
use serde_json::Value;

/// The server's name in a program's MCP settings and in `initialize`.
pub const SERVER: &str = "manut-threads";
/// The most chats on the outside list, and so the highest chat number a call may name.
pub const MAX_LIST: usize = 10;
/// The longest message and brief, as 102k's blocks take.
pub const MAX_MESSAGE: usize = 30_000;
pub const MAX_BRIEF: usize = 30_000;
/// The longest new lane's title and agent name.
pub const MAX_TITLE: usize = 120;
pub const MAX_AGENT: usize = 40;

/// The socket's folder.
pub fn dir(home: &Path) -> PathBuf {
    home.join(".manut").join("threads")
}

/// The socket in its folder: one name, since the app runs once per user.
pub fn socket_in(dir: &Path) -> PathBuf {
    dir.join("app.sock")
}

/// Where the relay finds the app.
pub fn socket(home: &Path) -> PathBuf {
    socket_in(&dir(home))
}

/// Where the switch is kept.
pub fn file(home: &Path) -> PathBuf {
    home.join(".manut").join("threads-mcp.json")
}

/// What the person chose in Settings, MCP and Skills, Other programs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Setting {
    pub on: bool,
}

/// The setting as saved, read so that anything but a saved `true` is off: a missing or unreadable file, `"yes"`, `1`.
pub fn load(home: &Path) -> Setting {
    let on = std::fs::read_to_string(file(home)).ok().and_then(|raw| serde_json::from_str::<Value>(&raw).ok()).and_then(|v| v.get("on").and_then(Value::as_bool)).unwrap_or(false);
    Setting { on }
}

/// Keeps the setting, written whole through a file beside it so a crash never leaves half of one.
pub fn save(home: &Path, s: &Setting) -> Result<(), String> {
    let path = file(home);
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Whether this build offers it: the Mac app, whose kernel names a caller (M3 to M6). Not the App Store edition, whose
/// sandbox was not checked against a socket another program's relay reaches.
pub fn available() -> bool {
    cfg!(target_os = "macos") && !crate::app_store::APP_STORE
}

/// The page's side of the door: an event to the window for each call, while the page has said it listens.
pub struct TauriPage {
    app: tauri::AppHandle,
    listening: AtomicBool,
}

impl door::Page for TauriPage {
    fn call(&self, call: &door::Call) -> bool {
        use tauri::Emitter;
        self.listening.load(Ordering::SeqCst) && self.app.emit("threads-mcp-call", call).is_ok()
    }
    fn gone(&self, id: &str) {
        use tauri::Emitter;
        let _ = self.app.emit("threads-mcp-gone", id);
    }
}

struct Started {
    door: Arc<door::Door>,
    page: Arc<TauriPage>,
}

static STARTED: OnceLock<Started> = OnceLock::new();
static HOME: OnceLock<PathBuf> = OnceLock::new();

/// Starts the door for the app: the folder and the socket. Once, on the Mac app only ([`available`]).
#[cfg(target_os = "macos")]
pub fn start(home: &Path, app: tauri::AppHandle) -> Result<(), String> {
    let _ = HOME.set(home.to_path_buf());
    let page = Arc::new(TauriPage { app, listening: AtomicBool::new(false) });
    let switch_home = home.to_path_buf();
    let d = door::Door::new(
        &dir(home),
        Arc::new(crate::computer::hub::system::System),
        page.clone(),
        Box::new(move || load(&switch_home).on),
        std::process::id() as i32,
        door::WAIT,
    )?;
    let d = Arc::new(d);
    d.listen()?;
    let _ = STARTED.set(Started { door: d, page });
    Ok(())
}

/// What Settings shows: the switch, whether this build offers it, and the command another program runs.
#[derive(Clone, Debug, Serialize)]
pub struct Shown {
    pub on: bool,
    pub available: bool,
    /// This app's program, as the address to copy names it; empty when it cannot be read.
    pub command: String,
    pub args: Vec<String>,
}

fn shown() -> Shown {
    let available = available() && STARTED.get().is_some();
    let on = available && HOME.get().is_some_and(|h| load(h).on);
    let command = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    Shown { on, available, command, args: vec![relay::FLAG.into()] }
}

/// Settings reads where the switch stands.
#[tauri::command]
pub fn threads_mcp_settings() -> Shown {
    shown()
}

/// Settings turns it on or off.
#[tauri::command]
pub fn threads_mcp_set(on: bool) -> Result<Shown, String> {
    if !(available() && STARTED.get().is_some()) {
        return Err("not offered in this build".into());
    }
    let home = HOME.get().ok_or("no home folder")?;
    save(home, &Setting { on })?;
    Ok(shown())
}

/// The page is ready to show the cards: from now on a call is handed to it.
#[tauri::command]
pub fn threads_mcp_listen() -> bool {
    match STARTED.get() {
        Some(s) => {
            s.page.listening.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

/// The page answers call `id`: the text the program hears, and whether it is a refusal. False when no call of that id
/// waits, so a card is settled once and a press on a closed card does nothing.
#[tauri::command]
pub fn threads_mcp_reply(id: String, text: String, error: bool) -> bool {
    let Some(s) = STARTED.get() else { return false };
    if text.chars().count() > door::REPLY_CHARS {
        return s.door.reply(&id, door::Reply { text: "The answer was too long to send. Nothing was sent.".into(), error: true });
    }
    s.door.reply(&id, door::Reply { text, error })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tm-home-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn anything_but_a_saved_true_is_off() {
        let h = home("switch");
        assert_eq!(load(&h), Setting { on: false });
        std::fs::create_dir_all(h.join(".manut")).unwrap();
        for raw in ["", "not json", r#"{"on": "yes"}"#, r#"{"on": 1}"#, r#"{"on": null}"#, r#"[true]"#, r#"{"enabled": true}"#] {
            std::fs::write(file(&h), raw).unwrap();
            assert_eq!(load(&h), Setting { on: false }, "{raw}");
        }
        save(&h, &Setting { on: true }).unwrap();
        assert_eq!(load(&h), Setting { on: true });
        save(&h, &Setting { on: false }).unwrap();
        assert_eq!(load(&h), Setting { on: false });
        assert!(!file(&h).with_extension("json.tmp").exists());
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn the_relay_and_the_app_agree_on_where_the_socket_is() {
        let h = Path::new("/Users/k");
        assert_eq!(socket(h), PathBuf::from("/Users/k/.manut/threads/app.sock"));
        assert_eq!(socket_in(&dir(h)), socket(h));
    }

    /// Without the door started (any test, or a build that does not offer it), nothing is offered and no reply lands.
    #[test]
    fn nothing_is_offered_before_the_door_starts() {
        let s = threads_mcp_settings();
        assert!(!s.on && !s.available);
        assert_eq!(s.args, [relay::FLAG]);
        assert!(threads_mcp_set(true).is_err());
        assert!(!threads_mcp_listen());
        assert!(!threads_mcp_reply("tm-1".into(), "Sent".into(), false));
    }
}
