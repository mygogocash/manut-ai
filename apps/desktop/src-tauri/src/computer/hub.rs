//! The shell's side of computer use: one socket the chats' MCP servers reach, one room per chat (`room.rs`), and the two
//! things a chat's Claude Code is handed when it starts: the MCP server's configuration and the skill.
//!
//! - `~/.manut/computer` is this user's alone (0700). In it: the socket (`app-<pid>.sock`) and the skill as a plugin
//!   folder (`plugin/`) Claude Code loads for that session only (`--plugin-dir`), so nothing is written in the person's
//!   own Claude Code folders. The MCP server's configuration, which names this program with `--computer-mcp` and gives
//!   the server the chat's token and the socket, goes on Claude Code's command line as a JSON string (`--mcp-config`
//!   takes a file or a string), so no file holds a token.
//! - A chat is handed computer use only on the Mac, only while macOS has given this app Accessibility (read without
//!   asking), and only a chat with cards (Buddy's and Kit's chats through Claude Code), never a terminal session, whose
//!   asks the shell never sees. The chat's room goes when the chat ends.
//! - A call on the socket is one line, `{token, tool, args}`, answered with one line, `{text, image?, error}`. The token
//!   names the chat; a token no chat holds is refused.
//!
//! **Who is calling, not only what they hold.** A token is not a secret from this user's other programs: any of them
//! can read a process's arguments and environment from the process list, and the token is in Claude Code's arguments
//! and in its server's environment. So the token only names the chat, and a call is served only when the program at the
//! other end of the connection, as the kernel recorded it, is the server Claude Code started for that chat:
//!
//! 1. Its parents reach the process the shell started for that chat ([`Hub::bind`]), within [`CHAIN`] steps
//!    (`proc_pidinfo` with `PROC_PIDTBSDINFO`). This is what binds a call to its chat: no program chooses its parents,
//!    so only one the chat's own Claude Code started can be under it. Not "its parent is that process": a `claude` on
//!    the person's `PATH` can be a wrapper that stays Claude Code's parent instead of replacing itself (one on this Mac
//!    does), and then the server's parent is Claude Code and its grandparent the process the shell started.
//! 2. It runs this app's own program. The peer is read from the socket (`LOCAL_PEERPID`, `LOCAL_PEERTOKEN`, `sys/un.h`)
//!    and its program through its audit token (`proc_pidpath_audittoken`, `libproc.h`), before and after the walk up its
//!    parents: a token stops naming anything once its process runs another program or ends, so both reads are of the
//!    same process running the same program. The kernel gives the token of the process as it is when asked, not as it
//!    was when it connected (checked on this Mac on 25 Nov 2026), so this rules out another program under the chat that
//!    speaks to the socket itself, not one that first runs this app's program, which (1) already limits to the chat.
//!
//! 3. It is the first caller that reached the chat's room ([`Hub::holds_room`], item 89, security review of 26 Nov 2026):
//!    the room is pinned to that caller's pid and audit token as the kernel reported them, and every other caller for that
//!    chat is refused while the first one lives (its token still names a running process). A program the chat's own
//!    Claude Code starts, such as a hook in the person's own settings that another program of theirs wrote, passes (1) and
//!    (2) when it runs this app's program. Once the first has ended or run another program (Claude Code starting its
//!    server again), the next caller that passes (1) and (2) takes its place.
//!
//! What this still lets through: a program under the chat's own Claude Code that calls before its server first does, or
//! after its server ended, reaches only that chat's room, with only the apps the person let that chat look at and the yeses
//! they gave on that chat's cards, each for exactly one call, and the server is then the one refused. A project's own files
//! can no longer add such a hook to a chat (`--setting-sources user`, `sessions::CLAUDE_CHAT_ARGS`). Another chat's agent, a
//! terminal, a repository's script started anywhere else, or a program started at login, is refused whatever it holds.

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

/// How many parents up a caller's line is followed to find its chat's process: Claude Code starts the server, and a
/// wrapper the person's `claude` may be adds a step or two. The line ends sooner at the system's first process.
pub const CHAIN: usize = 16;

/// What a call that did not come from its chat's own server is answered.
pub const NOT_ITS_SERVER: &str = "Computer use answers only the server Claude Code started for this chat, and this call did not come from it. Nothing was done.";

/// What a call is answered when another program of the chat already holds its room and still runs.
pub const NOT_THE_FIRST: &str = "Computer use answers only the first server that reached this chat, and that server still runs. Nothing was done.";

/// Who is at the other end of a connection, as the kernel recorded it when that program connected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caller {
    pub pid: i32,
    /// The process's audit token (`audit_token_t`, eight words) as the hub read it: it names that process running that
    /// program, and stops naming anything once the process runs another program or ends, as a process id alone does not.
    pub token: [u32; 8],
}

/// What the hub asks the system about a caller, behind one interface so the tests use a stand-in: no test can start
/// Claude Code.
pub trait Peers: Send + Sync {
    /// The program file `caller` runs, read through its audit token; None once it has run another program or ended
    /// since it connected, or when it cannot be read.
    fn program(&self, caller: &Caller) -> Option<PathBuf>;
    /// This app's own program file.
    fn own_program(&self) -> Option<PathBuf>;
    /// The parent of process `pid`.
    fn parent(&self, pid: i32) -> Option<i32>;
    /// The program file process `pid` runs now, read by its pid alone. Only for naming a program to the person (item 103's
    /// card names the program that started its relay); never for deciding who may call, which takes an audit token.
    fn pid_program(&self, _pid: i32) -> Option<PathBuf> {
        None
    }
}

/// The Mac's answers, from the kernel: the socket's peer, a program by audit token, a process's parent.
#[cfg(target_os = "macos")]
pub mod system {
    use std::ffi::c_void;
    use std::os::unix::io::AsRawFd;
    use std::os::unix::net::UnixStream;
    use std::path::PathBuf;

    use super::{Caller, Peers};

    /// `audit_token_t` (`mach/message.h`): eight unsigned words.
    #[repr(C)]
    struct AuditToken {
        val: [u32; 8],
    }

    extern "C" {
        /// `libproc.h` (macOS 11 and later, in libSystem): the path of the program the process `audittoken` names runs,
        /// failing when no process with that pid and that identity version is running (it ran another program, or ended).
        fn proc_pidpath_audittoken(audittoken: *mut AuditToken, buffer: *mut c_void, buffersize: u32) -> i32;
    }

    fn path_of(buf: &[u8], n: i32) -> Option<PathBuf> {
        (n > 0).then(|| PathBuf::from(String::from_utf8_lossy(&buf[..n as usize]).into_owned()))
    }

    /// The process at the other end of `s`: the pid recorded when it connected (`LOCAL_PEERPID`) and that process's
    /// audit token now (`LOCAL_PEERTOKEN`, which the kernel reads from the process when asked).
    pub fn caller_of(s: &UnixStream) -> Option<Caller> {
        let fd = s.as_raw_fd();
        let mut pid: libc::pid_t = 0;
        let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
        let got = unsafe { libc::getsockopt(fd, libc::SOL_LOCAL, libc::LOCAL_PEERPID, &mut pid as *mut _ as *mut c_void, &mut len) };
        if got != 0 || len as usize != std::mem::size_of::<libc::pid_t>() || pid <= 0 {
            return None;
        }
        let mut token = AuditToken { val: [0; 8] };
        let mut len = std::mem::size_of::<AuditToken>() as libc::socklen_t;
        let got = unsafe { libc::getsockopt(fd, libc::SOL_LOCAL, libc::LOCAL_PEERTOKEN, &mut token as *mut _ as *mut c_void, &mut len) };
        if got != 0 || len as usize != std::mem::size_of::<AuditToken>() {
            return None;
        }
        Some(Caller { pid, token: token.val })
    }

    pub struct System;

    impl Peers for System {
        fn program(&self, caller: &Caller) -> Option<PathBuf> {
            let mut token = AuditToken { val: caller.token };
            let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
            let n = unsafe { proc_pidpath_audittoken(&mut token, buf.as_mut_ptr() as *mut c_void, buf.len() as u32) };
            path_of(&buf, n)
        }

        fn own_program(&self) -> Option<PathBuf> {
            let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
            let n = unsafe { libc::proc_pidpath(std::process::id() as i32, buf.as_mut_ptr() as *mut c_void, buf.len() as u32) };
            path_of(&buf, n)
        }

        fn parent(&self, pid: i32) -> Option<i32> {
            let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
            let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
            let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut c_void, size) };
            (n == size).then_some(info.pbi_ppid as i32)
        }

        fn pid_program(&self, pid: i32) -> Option<PathBuf> {
            let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
            let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr() as *mut c_void, buf.len() as u32) };
            path_of(&buf, n)
        }
    }
}

/// What a chat is handed when computer use is on for it.
pub struct Attached {
    pub token: String,
    pub room: Arc<Room>,
    /// The arguments added to Claude Code's command line: `--mcp-config <JSON> --plugin-dir <folder>`.
    pub args: Vec<OsString>,
}

/// One chat's room, the process the shell started for it once it has started ([`Hub::bind`]), and the first caller that
/// reached the room, which holds it while it lives ([`Hub::holds_room`]).
struct Chat {
    room: Arc<Room>,
    pid: Option<i32>,
    first: Option<Caller>,
}

pub struct Hub {
    desk: Arc<dyn Desk>,
    peers: Arc<dyn Peers>,
    chats: Mutex<HashMap<String, Chat>>,
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

/// A token as the shell makes them: 32 lower-case hex characters.
#[cfg(test)]
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

/// Makes `dir` this user's alone, refusing one that is a link. Item 103's socket folder is made the same way.
pub(crate) fn private_dir(dir: &Path) -> Result<(), String> {
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
    /// The hub in `dir` (`~/.manut/computer`), over `desk`, asking `peers` who calls, with `exe` the program the chats'
    /// MCP servers run. Leftovers of an earlier run (sockets of processes gone, and the chats' files an earlier version
    /// wrote, which held tokens) are cleared, and the skill is written afresh.
    pub fn new(dir: &Path, desk: Arc<dyn Desk>, peers: Arc<dyn Peers>, exe: PathBuf) -> Result<Hub, String> {
        private_dir(dir)?;
        let old = dir.join("chats");
        if old.is_dir() && !old.is_symlink() {
            if let Ok(list) = std::fs::read_dir(&old) {
                for f in list.flatten() {
                    let _ = std::fs::remove_file(f.path());
                }
            }
            let _ = std::fs::remove_dir(&old);
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
        Ok(Hub { desk, peers, chats: Mutex::new(HashMap::new()), dir: dir.to_path_buf(), socket, exe })
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
        // who connected, read from the kernel before anything the caller wrote is read
        #[cfg(target_os = "macos")]
        let caller = system::caller_of(&s);
        #[cfg(not(target_os = "macos"))]
        let caller: Option<Caller> = None;
        let mut line = String::new();
        let Ok(r) = s.try_clone() else { return };
        if BufReader::new(r.take(LINE_BYTES)).read_line(&mut line).is_err() {
            return;
        }
        let mut s = s;
        let _ = s.write_all(self.answer(&line, caller.as_ref()).as_bytes()).and_then(|_| s.write_all(b"\n"));
    }

    /// Whether `caller` is the server Claude Code started for the chat whose process is `chat`: it runs this app's own
    /// program, read through its audit token, and its parents reach `chat`. The program is read again after the walk,
    /// so a caller that ran another program or ended meanwhile (its process id then free for another) is refused too.
    fn started_for(&self, chat: Option<i32>, caller: Option<&Caller>) -> bool {
        let (Some(chat), Some(caller)) = (chat, caller) else { return false };
        let Some(own) = self.peers.own_program() else { return false };
        let ours = |c: &Caller| self.peers.program(c).is_some_and(|p| p == own);
        if !ours(caller) {
            return false;
        }
        let mut at = caller.pid;
        for _ in 0..CHAIN {
            match self.peers.parent(at) {
                Some(up) if up == chat => return ours(caller),
                Some(up) if up > 1 && up != at => at = up,
                _ => return false,
            }
        }
        false
    }

    /// Whether `caller`, which [`Hub::started_for`] already let through, holds chat `token`'s room: it is the first caller
    /// pinned there (the same pid and the same audit token), or no caller is pinned, or the pinned one no longer runs (its
    /// token names no process: it ended, or ran another program), and then `caller` is pinned in its place. Read and
    /// written under one lock, so two callers can never both take an empty room.
    fn holds_room(&self, token: &str, caller: &Caller) -> bool {
        let mut chats = self.chats.lock().unwrap();
        let Some(chat) = chats.get_mut(token) else { return false };
        match chat.first {
            Some(first) if first == *caller => true,
            Some(first) if self.peers.program(&first).is_some() => false,
            _ => {
                chat.first = Some(*caller);
                true
            }
        }
    }

    /// The reply to one call line from `caller` (None: who it is could not be read).
    pub fn answer(&self, line: &str, caller: Option<&Caller>) -> String {
        let reply = |text: &str| json!({"text": text, "error": true}).to_string();
        let Ok(call) = serde_json::from_str::<Value>(line) else { return reply("That call could not be read.") };
        let token = call.get("token").and_then(Value::as_str).unwrap_or("");
        let Some((room, pid)) = self.chats.lock().unwrap().get(token).map(|c| (c.room.clone(), c.pid)) else {
            return reply("This chat's computer use has ended, or it was never Manut AI's. Nothing was done.");
        };
        if !self.started_for(pid, caller) {
            return reply(NOT_ITS_SERVER);
        }
        if !caller.is_some_and(|c| self.holds_room(token, c)) {
            return reply(NOT_THE_FIRST);
        }
        let tool = call.get("tool").and_then(Value::as_str).unwrap_or("");
        let args = call.get("args").cloned().unwrap_or_else(|| json!({}));
        let r = room.run(tool, &args);
        let mut out = json!({"text": r.text, "error": r.error});
        if let Some(png) = r.image {
            out["image"] = Value::String(base64(&png));
        }
        out.to_string()
    }

    /// Computer use for a chat that is starting, or None when this app has no Accessibility (read without asking).
    /// Nothing is served for it until the shell names the process it started ([`Hub::bind`]).
    pub fn attach(&self) -> Option<Attached> {
        if !self.desk.accessibility() {
            return None;
        }
        let token = token()?;
        let config = json!({"mcpServers": {super::SERVER: {
            "command": self.exe.to_string_lossy(),
            "args": [mcp::FLAG],
            "env": {mcp::TOKEN_VAR: token, mcp::SOCKET_VAR: self.socket.to_string_lossy()},
        }}});
        let room = Arc::new(Room::new(self.desk.clone()));
        self.chats.lock().unwrap().insert(token.clone(), Chat { room: room.clone(), pid: None, first: None });
        let args = vec!["--mcp-config".into(), config.to_string().into(), "--plugin-dir".into(), self.dir.join("plugin").into_os_string()];
        Some(Attached { token, room, args })
    }

    /// The shell started chat `token`'s Claude Code as process `pid`: only a server under it is served. Once: a chat's
    /// process is the one started for it, and nothing can name another.
    pub fn bind(&self, token: &str, pid: i32) {
        if let Some(c) = self.chats.lock().unwrap().get_mut(token) {
            if c.pid.is_none() && pid > 1 {
                c.pid = Some(pid);
            }
        }
    }

    /// The chat ended: its room goes, and its token opens nothing any more.
    pub fn detach(&self, token: &str) {
        self.chats.lock().unwrap().remove(token);
    }
}

static HUB: OnceLock<Arc<Hub>> = OnceLock::new();

/// Starts computer use's hub for the app, on the Mac: the folder, the skill and the socket. Once.
#[cfg(target_os = "macos")]
pub fn start(home: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let hub = Arc::new(Hub::new(&home.join(".manut").join("computer"), Arc::new(super::mac::Mac::new()), Arc::new(system::System), exe)?);
    hub.listen()?;
    let _ = HUB.set(hub);
    Ok(())
}

/// Computer use for a chat that is starting, when the hub runs (the Mac app) and Accessibility is on.
pub fn attach() -> Option<Attached> {
    HUB.get()?.attach()
}

/// The chat `token` was handed computer use and its Claude Code started as process `pid`.
pub fn bind(token: &str, pid: i32) {
    if let Some(h) = HUB.get() {
        h.bind(token, pid);
    }
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

    /// Where no peer can be read (anything but the Mac): every call is refused, as the socket refuses a caller it cannot
    /// read.
    #[cfg(not(target_os = "macos"))]
    struct NoPeers;

    #[cfg(not(target_os = "macos"))]
    impl Peers for NoPeers {
        fn program(&self, _: &Caller) -> Option<PathBuf> {
            None
        }
        fn own_program(&self) -> Option<PathBuf> {
            None
        }
        fn parent(&self, _: i32) -> Option<i32> {
            None
        }
    }

    /// The system's own answers where there are any (the Mac), else none.
    fn real_peers() -> Arc<dyn Peers> {
        #[cfg(target_os = "macos")]
        return Arc::new(system::System);
        #[cfg(not(target_os = "macos"))]
        Arc::new(NoPeers)
    }

    const APP: &str = "/Applications/Manut AI.app/Contents/MacOS/manut";

    /// A stand-in process table: each process's program, parent and identity version (what an audit token holds besides
    /// the pid, which an exec changes).
    struct Family {
        procs: Mutex<HashMap<i32, (u32, &'static str, i32)>>,
    }

    impl Family {
        /// The app (500); chat A's Claude Code (600), its server (601), another program under it (602); chat B's
        /// `claude` wrapper (700), the Claude Code under it (701) and its server (702); a terminal (800) and this app's
        /// program started from it (801).
        fn new() -> Family {
            let procs = [
                (500, (1, APP, 1)),
                (600, (1, "/Users/k/.local/bin/claude", 500)),
                (601, (1, APP, 600)),
                (602, (1, "/usr/bin/python3", 600)),
                (700, (1, "/bin/bash", 500)),
                (701, (1, "/Users/k/.local/bin/claude", 700)),
                (702, (1, APP, 701)),
                (800, (1, "/bin/zsh", 1)),
                (801, (1, APP, 800)),
                (900, (1, APP, 900)),
            ];
            Family { procs: Mutex::new(procs.into_iter().collect()) }
        }

        /// Process `pid` as it connected now.
        fn caller(&self, pid: i32) -> Caller {
            let v = self.procs.lock().unwrap()[&pid].0;
            Caller { pid, token: [v, 0, 0, 0, 0, pid as u32, 0, 0] }
        }

        /// Process `pid` runs another program: its identity version changes, as macOS's does on an exec.
        fn exec(&self, pid: i32, program: &'static str) {
            let mut p = self.procs.lock().unwrap();
            let e = p.get_mut(&pid).unwrap();
            *e = (e.0 + 1, program, e.2);
        }

        /// A new process `pid` running `program` under `parent`.
        fn spawn(&self, pid: i32, program: &'static str, parent: i32) {
            self.procs.lock().unwrap().insert(pid, (1, program, parent));
        }

        /// Process `pid` ended: its audit token names nothing any more.
        fn end(&self, pid: i32) {
            self.procs.lock().unwrap().remove(&pid);
        }
    }

    impl Peers for Family {
        fn program(&self, c: &Caller) -> Option<PathBuf> {
            let p = self.procs.lock().unwrap();
            p.get(&c.pid).filter(|e| e.0 == c.token[0]).map(|e| PathBuf::from(e.1))
        }
        fn own_program(&self) -> Option<PathBuf> {
            Some(PathBuf::from(APP))
        }
        fn parent(&self, pid: i32) -> Option<i32> {
            self.procs.lock().unwrap().get(&pid).map(|e| e.2)
        }
    }

    fn call(hub: &Hub, token: &str, tool: &str, caller: Option<&Caller>) -> Value {
        serde_json::from_str(&hub.answer(&json!({"token": token, "tool": tool, "args": {}}).to_string(), caller)).unwrap()
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
    /// configuration, as a JSON string on Claude Code's command line (no file holds its token), and the skill's folder.
    #[test]
    fn a_chat_is_handed_its_own_server_and_the_skill_only_with_accessibility() {
        let d = dir("attach");
        // a chat's file an earlier version wrote, with its token, is cleared
        std::fs::create_dir_all(d.join("chats")).unwrap();
        std::fs::write(d.join("chats").join("0123456789abcdef0123456789abcdef.json"), "{}").unwrap();
        let off = Hub::new(&d, Arc::new(Stand::new().no_accessibility()), real_peers(), APP.into()).unwrap();
        assert!(!d.join("chats").exists());
        assert!(off.attach().is_none());
        let hub = Hub::new(&d, Arc::new(Stand::new()), real_peers(), APP.into()).unwrap();
        let a = hub.attach().unwrap();
        assert!(token_ok(&a.token));
        assert_eq!(a.args.len(), 4);
        assert_eq!((a.args[0].to_str(), a.args[2].to_str()), (Some("--mcp-config"), Some("--plugin-dir")));
        assert_eq!(a.args[3], d.join("plugin").into_os_string());
        let config: Value = serde_json::from_str(a.args[1].to_str().unwrap()).unwrap();
        let server = &config["mcpServers"]["manut-computer"];
        assert_eq!(server["command"], APP);
        assert_eq!(server["args"], json!(["--computer-mcp"]));
        assert_eq!(server["env"]["MANUT_COMPUTER_TOKEN"], a.token.as_str());
        assert_eq!(server["env"]["MANUT_COMPUTER_SOCKET"], hub.socket().to_string_lossy().as_ref());
        // nothing under the folder holds the token
        fn holds(p: &Path, t: &str) -> bool {
            std::fs::read_dir(p).unwrap().flatten().any(|f| if f.path().is_dir() { holds(&f.path(), t) } else { std::fs::read_to_string(f.path()).unwrap_or_default().contains(t) || f.file_name().to_string_lossy().contains(t) })
        }
        assert!(!holds(&d, &a.token));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&d).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let skill = std::fs::read_to_string(d.join("plugin").join("skills").join("computer-use").join("SKILL.md")).unwrap();
        assert!(skill.starts_with("---\nname: computer-use\n"));
        let manifest: Value = serde_json::from_str(&std::fs::read_to_string(d.join("plugin").join(".claude-plugin").join("plugin.json")).unwrap()).unwrap();
        assert_eq!(manifest["name"], "manut-computer");
        // a second chat gets its own token and room
        let b = hub.attach().unwrap();
        assert_ne!(a.token, b.token);
        // the chat ends: its token opens nothing
        hub.detach(&a.token);
        let r = call(&hub, &a.token, "list_windows", None);
        assert_eq!(r["error"], true);
        assert!(r["text"].as_str().unwrap().contains("has ended"));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_call_with_a_token_no_chat_holds_does_nothing() {
        let d = dir("token");
        let stand = Arc::new(Stand::new());
        let family = Arc::new(Family::new());
        let hub = Hub::new(&d, stand.clone(), family.clone(), APP.into()).unwrap();
        let a = hub.attach().unwrap();
        hub.bind(&a.token, 600);
        let server = family.caller(601);
        for line in [json!({"token": "0123456789abcdef0123456789abcdef", "tool": "list_windows"}).to_string(), json!({"tool": "list_windows"}).to_string(), "not json".to_string()] {
            let r: Value = serde_json::from_str(&hub.answer(&line, Some(&server))).unwrap();
            assert_eq!(r["error"], true, "{line}");
        }
        assert!(stand.calls().is_empty(), "the Mac was not asked anything");
        let _ = std::fs::remove_dir_all(d);
    }

    /// Who calls, not only what they hold: with chat A's valid token, only the server under the process the shell
    /// started for chat A is served. Another program, this app's program started anywhere else (a terminal, another
    /// chat), a caller that became this app's program by exec after it connected, or any caller before the chat's process
    /// is known, is refused before the room is asked anything.
    #[test]
    fn only_the_server_claude_code_started_for_the_chat_is_served() {
        let d = dir("peers");
        let stand = Arc::new(Stand::new());
        let family = Arc::new(Family::new());
        let hub = Hub::new(&d, stand.clone(), family.clone(), APP.into()).unwrap();
        let a = hub.attach().unwrap();
        let b = hub.attach().unwrap();
        // before the shell names the chat's process, nothing is served, not even its own server
        assert_eq!(call(&hub, &a.token, "list_windows", Some(&family.caller(601)))["text"], NOT_ITS_SERVER);
        hub.bind(&a.token, 600);
        hub.bind(&b.token, 700);
        // and a chat's process is named once
        hub.bind(&a.token, 800);
        // the right one: chat A's server, and chat B's under a wrapper that stayed Claude Code's parent
        assert_eq!(call(&hub, &a.token, "list_windows", Some(&family.caller(601)))["error"], false);
        assert_eq!(call(&hub, &b.token, "list_windows", Some(&family.caller(702)))["error"], false);
        let n = stand.calls().len();
        for (who, token, caller) in [
            ("another program under chat A's Claude Code", &a.token, Some(family.caller(602))),
            ("this app's program started from a terminal", &a.token, Some(family.caller(801))),
            ("chat B's server with chat A's token", &a.token, Some(family.caller(702))),
            ("chat A's server with chat B's token", &b.token, Some(family.caller(601))),
            ("the app itself", &a.token, Some(family.caller(500))),
            ("chat A's Claude Code itself", &a.token, Some(family.caller(600))),
            ("a process that is its own parent", &a.token, Some(family.caller(900))),
            ("a caller who could not be read", &a.token, None),
        ] {
            let r = call(&hub, token, "list_windows", caller.as_ref());
            assert_eq!((r["error"].clone(), r["text"].clone()), (json!(true), json!(NOT_ITS_SERVER)), "{who}");
        }
        // a program that connected and then ran this app's program: its connect-time identity no longer names it
        let before = family.caller(602);
        family.exec(602, APP);
        assert_eq!(call(&hub, &a.token, "list_windows", Some(&before))["text"], NOT_ITS_SERVER);
        // the same for the chat's own server that ran something else after connecting
        let server = family.caller(601);
        family.exec(601, "/usr/bin/python3");
        assert_eq!(call(&hub, &a.token, "list_windows", Some(&server))["text"], NOT_ITS_SERVER);
        assert_eq!(stand.calls().len(), n, "no refused call read anything");
        // the chat ended: its own server is refused too
        hub.detach(&b.token);
        assert_eq!(call(&hub, &b.token, "list_windows", Some(&family.caller(702)))["error"], true);
        let _ = std::fs::remove_dir_all(d);
    }

    /// Item 89 (security review, 26 Nov 2026). A program the chat's own Claude Code starts and that runs this app's program
    /// with the chat's token passes the walk up its parents: a hook in the person's own settings, which another program of
    /// theirs may have written, is one. So a chat's room answers only the first caller that reached it, pinned by the pid and
    /// audit token the kernel reported, and refuses every other caller for that chat while that first one lives; once it has
    /// ended (Claude Code starting its server again), the next caller that passes the walk takes its place.
    #[test]
    fn a_chats_room_answers_only_its_first_caller_while_that_caller_lives() {
        let d = dir("first");
        let stand = Arc::new(Stand::new());
        let family = Arc::new(Family::new());
        let hub = Hub::new(&d, stand.clone(), family.clone(), APP.into()).unwrap();
        let a = hub.attach().unwrap();
        let b = hub.attach().unwrap();
        hub.bind(&a.token, 600);
        hub.bind(&b.token, 700);
        // chat A's own server calls first, and is answered on every call after
        for _ in 0..2 {
            assert_eq!(call(&hub, &a.token, "list_windows", Some(&family.caller(601)))["error"], false);
        }
        let n = stand.calls().len();
        // another program under chat A's Claude Code that runs this app's program, as a hook would: right under it, under a
        // shell the hook started, and under a wrapper further down
        family.spawn(603, APP, 600);
        family.spawn(604, "/bin/sh", 600);
        family.spawn(605, APP, 604);
        family.spawn(606, "/usr/bin/env", 604);
        family.spawn(607, APP, 606);
        for who in [603, 605, 607] {
            let r = call(&hub, &a.token, "get_app_state", Some(&family.caller(who)));
            assert_eq!((r["error"].clone(), r["text"].clone()), (json!(true), json!(NOT_THE_FIRST)), "{who}: {r}");
        }
        assert_eq!(stand.calls().len(), n, "no refused call read anything");
        // the first is still answered
        assert_eq!(call(&hub, &a.token, "list_windows", Some(&family.caller(601)))["error"], false);
        // the first caller is pinned even when it is not the chat's own server: then the server is the one refused, and
        // nothing more reaches the room than the person's cards let the first through
        family.spawn(703, APP, 701);
        assert_eq!(call(&hub, &b.token, "list_windows", Some(&family.caller(703)))["error"], false);
        assert_eq!(call(&hub, &b.token, "list_windows", Some(&family.caller(702)))["text"], NOT_THE_FIRST);
        // the first ended: the next caller that passes the walk takes its place, and the rest stay refused
        family.end(601);
        assert_eq!(call(&hub, &a.token, "list_windows", Some(&family.caller(603)))["error"], false);
        assert_eq!(call(&hub, &a.token, "list_windows", Some(&family.caller(605)))["text"], NOT_THE_FIRST);
        // the first ran another program: the token it was pinned by names nothing, so it no longer holds the room
        family.exec(603, "/usr/bin/python3");
        assert_eq!(call(&hub, &a.token, "list_windows", Some(&family.caller(605)))["error"], false);
        // a caller the walk refuses never takes the room, even when no first caller lives
        family.end(605);
        assert_eq!(call(&hub, &a.token, "list_windows", Some(&family.caller(801)))["text"], NOT_ITS_SERVER);
        assert_eq!(call(&hub, &a.token, "list_windows", Some(&family.caller(607)))["error"], false);
        // a chat that ends and a new one for the same process start with an empty room: nothing pinned carries over
        hub.detach(&a.token);
        let c = hub.attach().unwrap();
        hub.bind(&c.token, 600);
        family.spawn(608, APP, 600);
        assert_eq!(call(&hub, &c.token, "list_windows", Some(&family.caller(608)))["error"], false);
        assert_eq!(call(&hub, &c.token, "list_windows", Some(&family.caller(607)))["text"], NOT_THE_FIRST);
        let _ = std::fs::remove_dir_all(d);
    }

    /// A program that holds a live chat's token but was not started for that chat (here the test itself, which no chat
    /// started) is refused over the real socket, before the room is asked anything: the token alone opens nothing.
    #[cfg(unix)]
    #[test]
    fn a_program_the_chat_did_not_start_is_refused_even_with_its_token() {
        let d = dir("stranger");
        let stand = Arc::new(Stand::new());
        let hub = Arc::new(Hub::new(&d, stand.clone(), real_peers(), APP.into()).unwrap());
        hub.listen().unwrap();
        let a = hub.attach().unwrap();
        // the person already let this chat look at TextEdit, so a call the chat's own server made would be served
        let args = json!({"app": "TextEdit"});
        let crate::computer::room::Decision::Card(ask) = a.room.ask("get_app_state", &args) else { panic!("a card") };
        a.room.answered("get_app_state", &args, &ask);
        // the chat's Claude Code is some other process: here a short sleep the test started
        let other = std::process::Command::new("/bin/sleep").arg("5").spawn().unwrap();
        hub.bind(&a.token, other.id() as i32);
        let socket = hub.socket().to_string_lossy().into_owned();
        for tool in ["list_windows", "get_app_state"] {
            let r = mcp::over_socket(&socket, &a.token, tool, &args);
            assert_eq!(r["error"], true, "{tool}: {r}");
        }
        assert!(stand.calls().is_empty(), "no window was read");
        let mut other = other;
        let _ = other.kill();
        let _ = other.wait();
        let _ = std::fs::remove_dir_all(d);
    }

    /// The whole road a call takes, from the MCP server's relay over the socket to the room and back, with the stand-in
    /// Mac and the Mac's own reading of the peer: the test is the caller, runs the hub's own program, and is a child of
    /// the process the chat is bound to (the test's parent). Listing, then a look the person allowed, with its picture.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_call_goes_over_the_socket_to_its_chats_room_and_back() {
        let d = dir("socket");
        let stand = Arc::new(Stand::new());
        let hub = Arc::new(Hub::new(&d, stand.clone(), real_peers(), APP.into()).unwrap());
        hub.listen().unwrap();
        let a = hub.attach().unwrap();
        hub.bind(&a.token, std::os::unix::process::parent_id() as i32);
        let socket = hub.socket().to_string_lossy().into_owned();
        let r = mcp::over_socket(&socket, &a.token, "list_windows", &json!({}));
        assert_eq!(r["error"], false, "{r}");
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

    /// The Mac's kernel, read for real: the process at the other end of a connection, its parent and its program; and an
    /// audit token read before that process ran another program (exec) names nothing after it, so the two reads of a
    /// caller's program in [`Hub::answer`] are of one process running one program.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_kernel_names_the_caller_and_a_token_read_before_an_exec_names_nothing() {
        use std::os::unix::process::CommandExt;
        let d = dir("exec");
        std::fs::create_dir_all(&d).unwrap();
        let path = d.join("s.sock");
        let l = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
        for (i, b) in path.to_string_lossy().bytes().enumerate() {
            addr.sun_path[i] = b as libc::c_char;
        }
        // the child connects after the fork, then waits for a byte on `go` before running /bin/sleep
        let mut go = [0i32; 2];
        assert_eq!(unsafe { libc::pipe(go.as_mut_ptr()) }, 0);
        let (go_read, go_write) = (go[0], go[1]);
        let mut cmd = std::process::Command::new("/bin/sleep");
        cmd.arg("5");
        unsafe {
            cmd.pre_exec(move || {
                let fd = libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0);
                if fd < 0 || libc::connect(fd, &addr as *const _ as *const libc::sockaddr, std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                let mut b = 0u8;
                libc::read(go_read, &mut b as *mut u8 as *mut libc::c_void, 1);
                Ok(())
            });
        }
        // the hub's side: who connected, read while the child still runs this test's program; then let it go on
        let side = std::thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let before = system::caller_of(&s).unwrap();
            let p = system::System;
            let program_then = p.program(&before);
            unsafe { libc::write(go_write, b"x".as_ptr() as *const libc::c_void, 1) };
            (s, before, program_then, l)
        });
        let mut child = cmd.spawn().unwrap();
        let (s, before, program_then, l) = side.join().unwrap();
        let peers = system::System;
        assert_eq!(before.pid, child.id() as i32);
        assert_eq!(program_then, peers.own_program(), "before its exec the child ran this test's program");
        assert_eq!(peers.parent(before.pid), Some(std::process::id() as i32));
        assert_eq!(peers.program(&before), None, "the token read before the exec names nothing after it");
        let now = system::caller_of(&s).unwrap();
        assert_eq!(peers.program(&now), Some(PathBuf::from("/bin/sleep")));
        // this test connecting to its own listener reads as its own program
        let me = std::os::unix::net::UnixStream::connect(&path).unwrap();
        let (mine, _) = l.accept().unwrap();
        let caller = system::caller_of(&mine).unwrap();
        assert_eq!(caller.pid, std::process::id() as i32);
        assert_eq!(peers.program(&caller), peers.own_program());
        assert!(peers.own_program().is_some());
        drop(me);
        unsafe {
            libc::close(go_read);
            libc::close(go_write);
        }
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(d);
    }
}
