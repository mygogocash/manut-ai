//! The shell's side of computer use: one socket the chats' MCP servers reach, one room per chat (`room.rs`), and the two
//! things a chat's Claude Code is handed when it starts: the MCP server's configuration and the skill.
//!
//! - `~/.manut/computer` is this user's alone (0700). In it: the socket (`app-<pid>.sock`); each chat's configuration
//!   (`chats/<token>.json`, 0600), which names this program with `--computer-mcp` and gives the server the chat's
//!   token and the socket; and the skill as a plugin folder (`plugin/`) Claude Code loads for that session only
//!   (`--plugin-dir`), so nothing is written in the person's own Claude Code folders.
//! - A chat is handed computer use only on the Mac, only while macOS has given this app Accessibility (read without
//!   asking), and only a chat with cards (Buddy's and Kit's chats through Claude Code), never a terminal session, whose
//!   asks the shell never sees. The chat's room and file go when the chat ends.
//! - A call on the socket is one line, `{token, tool, args}`, answered with one line, `{text, image?, error}`. The token
//!   names the chat; a token no chat holds is refused.

// Only the Mac starts a hub; elsewhere `attach` finds none and the rest is there for the tests.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Value};

use super::mcp;
use super::room::{Desk, Room};

/// The skill Claude Code is given with the tools (from Orca's `orca-computer-use` guide).
pub const SKILL: &str = include_str!("SKILL.md");

/// The longest call line read.
const LINE_BYTES: u64 = 1 << 20;

/// What a chat is handed when computer use is on for it.
pub struct Attached {
    pub token: String,
    pub room: Arc<Room>,
    /// The arguments added to Claude Code's command line: `--mcp-config <file> --plugin-dir <folder>`.
    pub args: Vec<OsString>,
}

pub struct Hub {
    desk: Arc<dyn Desk>,
    rooms: Mutex<HashMap<String, Arc<Room>>>,
    dir: PathBuf,
    socket: PathBuf,
    exe: PathBuf,
}

/// A new token: 16 random bytes as hex, from the system's random source.
fn token() -> Option<String> {
    let mut b = [0u8; 16];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).ok()?;
    Some(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// A token as the shell makes them: 32 lower-case hex characters, so one can name a file and nothing else.
fn token_ok(t: &str) -> bool {
    t.len() == 32 && t.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// `bytes` in standard base64, for a picture in the reply line.
pub fn base64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                out.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Writes `data` to `path` readable by this user alone.
fn write_private(path: &Path, data: &str) -> Result<(), String> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    let mut f = o.open(path).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    f.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

/// Makes `dir` this user's alone, refusing one that is a link.
fn private_dir(dir: &Path) -> Result<(), String> {
    if dir.is_symlink() {
        return Err(format!("{} is a link", dir.display()));
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("could not make {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

impl Hub {
    /// The hub in `dir` (`~/.manut/computer`), over `desk`, with `exe` the program the chats' MCP servers run. Leftovers
    /// of an earlier run (chats' files, sockets of processes gone) are cleared, and the skill is written afresh.
    pub fn new(dir: &Path, desk: Arc<dyn Desk>, exe: PathBuf) -> Result<Hub, String> {
        for d in [dir.to_path_buf(), dir.join("chats")] {
            private_dir(&d)?;
        }
        if let Ok(list) = std::fs::read_dir(dir.join("chats")) {
            for f in list.flatten() {
                let _ = std::fs::remove_file(f.path());
            }
        }
        if let Ok(list) = std::fs::read_dir(dir) {
            for f in list.flatten() {
                let name = f.file_name().to_string_lossy().into_owned();
                let pid = name.strip_prefix("app-").and_then(|n| n.strip_suffix(".sock")).and_then(|n| n.parse::<i32>().ok());
                #[cfg(unix)]
                let gone = pid.is_some_and(|p| unsafe { libc::kill(p, 0) } != 0);
                #[cfg(not(unix))]
                let gone = pid.is_some();
                if gone {
                    let _ = std::fs::remove_file(f.path());
                }
            }
        }
        let plugin = dir.join("plugin");
        for d in [plugin.join(".claude-plugin"), plugin.join("skills").join("computer-use")] {
            std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
        }
        let manifest = json!({
            "name": "manut-computer",
            "displayName": "Manut AI computer use",
            "version": env!("CARGO_PKG_VERSION"),
            "description": "Look at and work the windows of this Mac's apps, asking the person before each action.",
            "author": {"name": "Manut AI"},
            "license": "MIT",
        });
        std::fs::write(plugin.join(".claude-plugin").join("plugin.json"), serde_json::to_string_pretty(&manifest).unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(plugin.join("skills").join("computer-use").join("SKILL.md"), SKILL).map_err(|e| e.to_string())?;
        let socket = dir.join(format!("app-{}.sock", std::process::id()));
        Ok(Hub { desk, rooms: Mutex::new(HashMap::new()), dir: dir.to_path_buf(), socket, exe })
    }

    #[cfg(test)]
    pub fn socket(&self) -> &Path {
        &self.socket
    }

    /// Listens on the socket, one thread per call.
    #[cfg(unix)]
    pub fn listen(self: &Arc<Self>) -> Result<(), String> {
        let _ = std::fs::remove_file(&self.socket);
        let l = std::os::unix::net::UnixListener::bind(&self.socket).map_err(|e| format!("could not open computer use's socket: {e}"))?;
        let hub = self.clone();
        std::thread::Builder::new()
            .name("computer-use".into())
            .spawn(move || {
                for s in l.incoming().flatten() {
                    let hub = hub.clone();
                    let _ = std::thread::Builder::new().name("computer-call".into()).spawn(move || hub.serve(s));
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(unix)]
    fn serve(&self, s: std::os::unix::net::UnixStream) {
        let mut line = String::new();
        let Ok(r) = s.try_clone() else { return };
        if BufReader::new(r.take(LINE_BYTES)).read_line(&mut line).is_err() {
            return;
        }
        let mut s = s;
        let _ = s.write_all(self.answer(&line).as_bytes()).and_then(|_| s.write_all(b"\n"));
    }

    /// The reply to one call line.
    pub fn answer(&self, line: &str) -> String {
        let reply = |text: &str| json!({"text": text, "error": true}).to_string();
        let Ok(call) = serde_json::from_str::<Value>(line) else { return reply("That call could not be read.") };
        let token = call.get("token").and_then(Value::as_str).unwrap_or("");
        let Some(room) = self.rooms.lock().unwrap().get(token).cloned() else {
            return reply("This chat's computer use has ended, or it was never Manut AI's. Nothing was done.");
        };
        let tool = call.get("tool").and_then(Value::as_str).unwrap_or("");
        let args = call.get("args").cloned().unwrap_or_else(|| json!({}));
        let r = room.run(tool, &args);
        let mut out = json!({"text": r.text, "error": r.error});
        if let Some(png) = r.image {
            out["image"] = Value::String(base64(&png));
        }
        out.to_string()
    }

    /// Computer use for a chat that is starting, or None when this app has no Accessibility (read without asking) or
    /// its files cannot be written.
    pub fn attach(&self) -> Option<Attached> {
        if !self.desk.accessibility() {
            return None;
        }
        let token = token()?;
        let file = self.dir.join("chats").join(format!("{token}.json"));
        let config = json!({"mcpServers": {super::SERVER: {
            "command": self.exe.to_string_lossy(),
            "args": [mcp::FLAG],
            "env": {mcp::TOKEN_VAR: token, mcp::SOCKET_VAR: self.socket.to_string_lossy()},
        }}});
        write_private(&file, &config.to_string()).ok()?;
        let room = Arc::new(Room::new(self.desk.clone()));
        self.rooms.lock().unwrap().insert(token.clone(), room.clone());
        let args = vec!["--mcp-config".into(), file.into_os_string(), "--plugin-dir".into(), self.dir.join("plugin").into_os_string()];
        Some(Attached { token, room, args })
    }

    /// The chat ended: its room and its file go, and its token opens nothing any more.
    pub fn detach(&self, token: &str) {
        self.rooms.lock().unwrap().remove(token);
        if token_ok(token) {
            let _ = std::fs::remove_file(self.dir.join("chats").join(format!("{token}.json")));
        }
    }
}

static HUB: OnceLock<Arc<Hub>> = OnceLock::new();

/// Starts computer use's hub for the app, on the Mac: the folder, the skill and the socket. Once.
#[cfg(target_os = "macos")]
pub fn start(home: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let hub = Arc::new(Hub::new(&home.join(".manut").join("computer"), Arc::new(super::mac::Mac::new()), exe)?);
    hub.listen()?;
    let _ = HUB.set(hub);
    Ok(())
}

/// Computer use for a chat that is starting, when the hub runs (the Mac app) and Accessibility is on.
pub fn attach() -> Option<Attached> {
    HUB.get()?.attach()
}

pub fn detach(token: &str) {
    if let Some(h) = HUB.get() {
        h.detach(token);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer::stand::Stand;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mc-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn base64_is_the_standard_one() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0x89, b'P', b'N', b'G', 0xff]), "iVBOR/8=");
    }

    /// A chat is handed computer use only while Accessibility is on, and then exactly two things: its own MCP
    /// configuration, readable by this user alone, and the skill's folder.
    #[test]
    fn a_chat_is_handed_its_own_server_and_the_skill_only_with_accessibility() {
        let d = dir("attach");
        let off = Hub::new(&d, Arc::new(Stand::new().no_accessibility()), "/Applications/Manut AI.app/Contents/MacOS/manut".into()).unwrap();
        assert!(off.attach().is_none());
        let hub = Hub::new(&d, Arc::new(Stand::new()), "/Applications/Manut AI.app/Contents/MacOS/manut".into()).unwrap();
        let a = hub.attach().unwrap();
        assert!(token_ok(&a.token));
        let file = d.join("chats").join(format!("{}.json", a.token));
        assert_eq!(a.args, vec![OsString::from("--mcp-config"), file.clone().into(), "--plugin-dir".into(), d.join("plugin").into()]);
        let config: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        let server = &config["mcpServers"]["manut-computer"];
        assert_eq!(server["command"], "/Applications/Manut AI.app/Contents/MacOS/manut");
        assert_eq!(server["args"], json!(["--computer-mcp"]));
        assert_eq!(server["env"]["MANUT_COMPUTER_TOKEN"], a.token.as_str());
        assert_eq!(server["env"]["MANUT_COMPUTER_SOCKET"], hub.socket().to_string_lossy().as_ref());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(&d).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let skill = std::fs::read_to_string(d.join("plugin").join("skills").join("computer-use").join("SKILL.md")).unwrap();
        assert!(skill.starts_with("---\nname: computer-use\n"));
        let manifest: Value = serde_json::from_str(&std::fs::read_to_string(d.join("plugin").join(".claude-plugin").join("plugin.json")).unwrap()).unwrap();
        assert_eq!(manifest["name"], "manut-computer");
        // a second chat gets its own token and room
        let b = hub.attach().unwrap();
        assert_ne!(a.token, b.token);
        // the chat ends: its file and its token go
        hub.detach(&a.token);
        assert!(!file.exists());
        let r: Value = serde_json::from_str(&hub.answer(&json!({"token": a.token, "tool": "list_windows", "args": {}}).to_string())).unwrap();
        assert_eq!(r["error"], true);
        assert!(r["text"].as_str().unwrap().contains("has ended"));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_call_with_a_token_no_chat_holds_does_nothing() {
        let d = dir("token");
        let stand = Arc::new(Stand::new());
        let hub = Hub::new(&d, stand.clone(), "/x/manut".into()).unwrap();
        let _a = hub.attach().unwrap();
        for line in [json!({"token": "0123456789abcdef0123456789abcdef", "tool": "list_windows"}).to_string(), json!({"tool": "list_windows"}).to_string(), "not json".to_string()] {
            let r: Value = serde_json::from_str(&hub.answer(&line)).unwrap();
            assert_eq!(r["error"], true, "{line}");
        }
        assert!(stand.calls().is_empty(), "the Mac was not asked anything");
        let _ = std::fs::remove_dir_all(d);
    }

    /// The whole road a call takes, from the MCP server's relay over the socket to the room and back, with the stand-in
    /// Mac: listing, then a look the person allowed, with its picture.
    #[cfg(unix)]
    #[test]
    fn a_call_goes_over_the_socket_to_its_chats_room_and_back() {
        let d = dir("socket");
        let stand = Arc::new(Stand::new());
        let hub = Arc::new(Hub::new(&d, stand.clone(), "/x/manut".into()).unwrap());
        hub.listen().unwrap();
        let a = hub.attach().unwrap();
        let socket = hub.socket().to_string_lossy().into_owned();
        let r = mcp::over_socket(&socket, &a.token, "list_windows", &json!({}));
        assert_eq!(r["error"], false);
        assert!(r["text"].as_str().unwrap().contains("TextEdit"));
        let args = json!({"app": "TextEdit", "picture": true});
        let crate::computer::room::Decision::Card(ask) = a.room.ask("get_app_state", &args) else { panic!("a card") };
        a.room.answered("get_app_state", &args, &ask);
        let r = mcp::over_socket(&socket, &a.token, "get_app_state", &args);
        assert_eq!(r["error"], false, "{r}");
        assert!(r["text"].as_str().unwrap().contains("[2] button “Save”"));
        assert_eq!(r["image"], base64(b"\x89PNG stand-in"));
        let _ = std::fs::remove_dir_all(d);
    }
}
