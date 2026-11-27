//! The shell's side of item 103 (`docs/mcp-threads.md`): one socket the relays reach, who is calling read from the kernel,
//! each program's run and whether the person let it in, and each call handed to the page, which shows the card and acts.
//!
//! The door decides who may ask, never what happens to a chat: the chats, item 97's text, the sessions store's `route` and
//! `startOpenedLane` are the page's (103b to 103d). It refuses, before the page hears anything:
//!
//! - **M1**: everything while the switch is off.
//! - **M3**: a caller that does not run this app's own program, read through its audit token before and after the walks up
//!   its parents (`computer::hub`'s rule 2, through the same [`Peers`]). A program that speaks to the socket itself, or ran
//!   another program meanwhile, is refused.
//! - **M5**: a relay whose parents reach this app's own process: a chat, lane, terminal or Buddy's chat the app started would
//!   get this server through the person's user-wide MCP settings (item 72), and 102k's Kit may reach is the road between the
//!   app's own chats.
//! - **M6**: a program the person said No to, for the rest of its run, and every call of a program whose let-in card waits.
//! - **M10**: a second call while one of the same program waits, and more than [`PER_MINUTE`] calls a minute.
//!
//! **M4**: the program on a card is named by the kernel: the relay's first parent that is not a shell or `env`, by its
//! `.app` bundle's name and its whole path. What the program calls itself in `initialize` is only `calls_itself`.
//!
//! **M11**: a call waits at most [`WAIT`] for the person; a call whose relay closed its connection first (the program gave up)
//! is closed at once. Either way the page hears `gone` and the card closes, and a late reply finds nothing to answer.
//!
//! **M13**: no refusal holds anything of the call, and nothing here logs a call.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use super::relay::{LIST, OPEN, READ, SEND};
use crate::computer::hub::{private_dir, Caller, Peers, CHAIN};

/// The longest a call waits for the person before its card closes.
pub const WAIT: Duration = Duration::from_secs(10 * 60);

/// The most calls one program may make in a minute; more are refused.
pub const PER_MINUTE: usize = 30;

/// The page's card for a program the person has not let in yet: a call with this tool and no arguments.
pub const LET_IN: &str = "let_in";

/// The longest call line read: a message of 30,000 characters fits many times over.
const LINE_BYTES: u64 = 1 << 20;

/// The longest reply the page may give: item 97's text is capped far below it.
pub const REPLY_CHARS: usize = 200_000;

/// The programs passed over when naming the program that started a relay: a program starts its server through one of
/// these as often as directly, and the person knows the program, not its shell.
const SHELLS: [&str; 10] = ["sh", "bash", "zsh", "dash", "fish", "ksh", "csh", "tcsh", "env", "login"];

/// The longest a program's own name for itself is shown.
const CALLS_ITSELF_CHARS: usize = 80;

pub const OFF: &str = "Turned off in Manut AI, in Settings, MCP and Skills, Other programs. Nothing was done.";
pub const NOT_OURS: &str = "Manut AI answers only its own relay, started as manut --threads-mcp. Nothing was done.";
pub const INSIDE: &str = "Chats in Manut AI reach other chats through Kit may reach, not through this server. Nothing was done.";
pub const REFUSED_RUN: &str = "The person did not let this program reach their chats while it runs. Nothing was done.";
pub const ONE_AT_A_TIME: &str = "One ask at a time: the person has not answered the last one. Nothing was done.";
pub const TOO_MANY: &str = "Too many calls in the last minute. Nothing was done; wait a minute.";
pub const NO_WINDOW: &str = "Manut AI's window is not ready to show the person a card. Nothing was done.";
pub const GONE: &str = "The call was given up before the person answered. Nothing was done.";
pub const TIMED_OUT: &str = "The person did not answer within ten minutes, so the card was closed. Nothing was done.";
pub const UNREADABLE: &str = "That call could not be read. Nothing was done.";
pub const UNKNOWN_PROGRAM: &str = "An unknown program";

/// The program a card names.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Program {
    /// From the kernel: the bundle's name, or the program file's name.
    pub name: String,
    /// The program file's whole path, from the kernel; empty when none was found.
    pub path: String,
    /// What the program called itself in `initialize`: its own words, shown only as such.
    pub calls_itself: Option<String>,
}

/// One call handed to the page.
#[derive(Clone, Debug, Serialize)]
pub struct Call {
    pub id: String,
    /// One of the relay's four tools, or [`LET_IN`].
    pub tool: String,
    pub args: Value,
    pub program: Program,
}

/// The page's answer to a call: the text the program hears, and whether it is a refusal. For [`LET_IN`], `error: false`
/// is the person's Let in and `true` their No.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reply {
    pub text: String,
    pub error: bool,
}

/// What the door asks of the page, behind one interface so the tests use a stand-in.
pub trait Page: Send + Sync {
    /// Hands `call` to the page, which shows its card; false when no page listens (the window is not ready).
    fn call(&self, call: &Call) -> bool;
    /// The call `id` is gone: its program gave up, or the person did not answer in time. Its card closes.
    fn gone(&self, id: &str);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    /// The person has not let this run in yet.
    New,
    In,
    /// The person said No: refused for the rest of the run.
    Out,
}

/// One run of one program: its relay, as the kernel named it when it connected.
struct Run {
    caller: Caller,
    state: State,
    /// A call of this run waits on the page.
    busy: bool,
    recent: VecDeque<Instant>,
}

enum Asked {
    Answered(Reply),
    Closed(&'static str),
}

pub struct Door {
    peers: Arc<dyn Peers>,
    page: Arc<dyn Page>,
    on: Box<dyn Fn() -> bool + Send + Sync>,
    own_pid: i32,
    wait: Duration,
    runs: Mutex<Vec<Run>>,
    pending: Mutex<HashMap<String, mpsc::Sender<Reply>>>,
    next: AtomicU64,
    socket: PathBuf,
}

/// Clears a run's busy mark when its call ends, however it ends.
struct Busy<'a> {
    door: &'a Door,
    caller: Caller,
}

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        if let Some(r) = self.door.runs.lock().unwrap().iter_mut().find(|r| r.caller == self.caller) {
            r.busy = false;
        }
    }
}

/// `t` as a card may show it: no invisible formatting or control characters, trimmed, cut to `n` characters.
fn shown(t: &str, n: usize) -> String {
    let t: String = crate::computer::room::clean(t).chars().filter(|c| !c.is_control()).collect();
    t.trim().chars().take(n).collect()
}

/// The name a person knows a program file by: its outermost `.app` bundle's name (Cursor's helper inside `Cursor.app` is
/// Cursor), else the file's name.
pub fn named(p: &Path) -> String {
    for c in p.components() {
        if let Some(n) = c.as_os_str().to_str().and_then(|s| s.strip_suffix(".app")).filter(|n| !n.is_empty()) {
            return shown(n, CALLS_ITSELF_CHARS);
        }
    }
    p.file_name().map(|f| shown(&f.to_string_lossy(), CALLS_ITSELF_CHARS)).filter(|n| !n.is_empty()).unwrap_or_else(|| UNKNOWN_PROGRAM.into())
}

/// Whether a connection's other end is still open: a closed one reads as an end of file at once. The relay writes one
/// line and nothing more, so anything readable is not a close.
#[cfg(unix)]
fn still_open(s: &std::os::unix::net::UnixStream) -> bool {
    use std::os::unix::io::AsRawFd;
    let mut b = 0u8;
    let n = unsafe { libc::recv(s.as_raw_fd(), &mut b as *mut u8 as *mut libc::c_void, 1, libc::MSG_PEEK | libc::MSG_DONTWAIT) };
    if n >= 0 {
        return n > 0;
    }
    let e = std::io::Error::last_os_error().raw_os_error();
    e == Some(libc::EAGAIN) || e == Some(libc::EWOULDBLOCK) || e == Some(libc::EINTR)
}

impl Door {
    /// The door in `dir` (`~/.manut/threads`), asking `peers` who calls and `page` to show cards, open only while `on`
    /// says so, with `own_pid` this app's process and `wait` how long a call waits for the person.
    pub fn new(dir: &Path, peers: Arc<dyn Peers>, page: Arc<dyn Page>, on: Box<dyn Fn() -> bool + Send + Sync>, own_pid: i32, wait: Duration) -> Result<Door, String> {
        private_dir(dir)?;
        Ok(Door {
            peers,
            page,
            on,
            own_pid,
            wait,
            runs: Mutex::new(Vec::new()),
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            socket: super::socket_in(dir),
        })
    }

    /// Listens on the socket, one thread per call. The app runs once per user, so a socket file left by an earlier run is
    /// replaced; the file is this user's alone, inside a folder that is too.
    #[cfg(unix)]
    pub fn listen(self: &Arc<Self>) -> Result<(), String> {
        use std::os::unix::fs::PermissionsExt;
        if self.socket.is_symlink() || self.socket.exists() {
            std::fs::remove_file(&self.socket).map_err(|e| format!("could not clear the old socket: {e}"))?;
        }
        let l = std::os::unix::net::UnixListener::bind(&self.socket).map_err(|e| format!("could not open the threads socket: {e}"))?;
        std::fs::set_permissions(&self.socket, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
        let door = self.clone();
        std::thread::Builder::new()
            .name("threads-mcp".into())
            .spawn(move || {
                for s in l.incoming().flatten() {
                    let door = door.clone();
                    let _ = std::thread::Builder::new().name("threads-mcp-call".into()).spawn(move || door.serve(s));
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(unix)]
    fn serve(&self, s: std::os::unix::net::UnixStream) {
        // who connected, read from the kernel before anything the caller wrote is read
        #[cfg(target_os = "macos")]
        let caller = crate::computer::hub::system::caller_of(&s);
        #[cfg(not(target_os = "macos"))]
        let caller: Option<Caller> = None;
        let mut line = String::new();
        let Ok(r) = s.try_clone() else { return };
        if BufReader::new(r.take(LINE_BYTES)).read_line(&mut line).is_err() {
            return;
        }
        let answer = self.answer(&line, caller.as_ref(), &|| still_open(&s));
        let mut s = s;
        let _ = s.write_all(answer.as_bytes()).and_then(|_| s.write_all(b"\n"));
    }

    /// Whether `caller` runs this app's own program, read through its audit token now.
    fn ours(&self, caller: &Caller) -> bool {
        let Some(own) = self.peers.own_program() else { return false };
        self.peers.program(caller).is_some_and(|p| p == own)
    }

    /// Whether the parents of process `pid` reach this app's own process within `CHAIN` steps.
    fn inside(&self, pid: i32) -> bool {
        let mut at = pid;
        for _ in 0..CHAIN {
            match self.peers.parent(at) {
                Some(up) if up == self.own_pid => return true,
                Some(up) if up > 1 && up != at => at = up,
                _ => return false,
            }
        }
        false
    }

    /// The program that started `caller`'s relay, and what it called itself (`client`, from the relay).
    fn program(&self, caller: &Caller, client: Option<&Value>) -> Program {
        let calls_itself = client.and_then(|c| {
            let name = c.get("name").and_then(Value::as_str).unwrap_or("");
            let version = c.get("version").and_then(Value::as_str).unwrap_or("");
            let t = shown(&format!("{name} {version}"), CALLS_ITSELF_CHARS);
            (!t.is_empty()).then_some(t)
        });
        let mut at = caller.pid;
        for _ in 0..CHAIN {
            let Some(up) = self.peers.parent(at).filter(|up| *up > 1 && *up != at) else { break };
            if let Some(p) = self.peers.pid_program(up) {
                let file = p.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
                if !SHELLS.contains(&file.as_str()) {
                    return Program { name: named(&p), path: shown(&p.to_string_lossy(), 4096), calls_itself };
                }
            }
            at = up;
        }
        Program { name: UNKNOWN_PROGRAM.into(), path: String::new(), calls_itself }
    }

    /// Takes a call of `caller`'s run: its state, after forgetting runs that ended, refusing a run the person said No to,
    /// one that is busy or one past the limit. The run is marked busy until the returned guard drops.
    fn enter(&self, caller: &Caller) -> Result<(State, Busy<'_>), &'static str> {
        let mut runs = self.runs.lock().unwrap();
        // a run whose relay ended or ran another program names nothing any more: forget it
        runs.retain(|r| self.peers.program(&r.caller).is_some());
        let i = match runs.iter().position(|r| r.caller == *caller) {
            Some(i) => i,
            None => {
                runs.push(Run { caller: *caller, state: State::New, busy: false, recent: VecDeque::new() });
                runs.len() - 1
            }
        };
        let run = &mut runs[i];
        if run.state == State::Out {
            return Err(REFUSED_RUN);
        }
        if run.busy {
            return Err(ONE_AT_A_TIME);
        }
        let now = Instant::now();
        while run.recent.front().is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(60)) {
            run.recent.pop_front();
        }
        if run.recent.len() >= PER_MINUTE {
            return Err(TOO_MANY);
        }
        run.recent.push_back(now);
        run.busy = true;
        Ok((run.state, Busy { door: self, caller: *caller }))
    }

    fn set(&self, caller: &Caller, state: State) {
        if let Some(r) = self.runs.lock().unwrap().iter_mut().find(|r| r.caller == *caller) {
            r.state = state;
        }
    }

    /// Hands `call` to the page and waits for its reply, until `alive` says the relay closed its connection or `wait`
    /// passes; then the page hears the call is gone.
    fn ask(&self, call: &Call, alive: &dyn Fn() -> bool) -> Asked {
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(call.id.clone(), tx);
        if !self.page.call(call) {
            self.pending.lock().unwrap().remove(&call.id);
            return Asked::Closed(NO_WINDOW);
        }
        let start = Instant::now();
        loop {
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(r) => return Asked::Answered(r),
                Err(mpsc::RecvTimeoutError::Disconnected) => return Asked::Closed(GONE),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let gone = !alive();
                    if gone || start.elapsed() >= self.wait {
                        self.pending.lock().unwrap().remove(&call.id);
                        // a reply that came in just before the entry was taken out is the answer
                        if let Ok(r) = rx.try_recv() {
                            return Asked::Answered(r);
                        }
                        self.page.gone(&call.id);
                        return Asked::Closed(if gone { GONE } else { TIMED_OUT });
                    }
                }
            }
        }
    }

    fn new_id(&self) -> String {
        format!("tm-{}", self.next.fetch_add(1, Ordering::Relaxed))
    }

    /// The reply line to one call line from `caller` (None: who it is could not be read). `alive` says whether the relay
    /// still holds its connection open.
    pub fn answer(&self, line: &str, caller: Option<&Caller>, alive: &dyn Fn() -> bool) -> String {
        let no = |t: &str| json!({"text": t, "error": true}).to_string();
        let Ok(call) = serde_json::from_str::<Value>(line) else { return no(UNREADABLE) };
        let Some(caller) = caller else { return no(NOT_OURS) };
        if !self.ours(caller) {
            return no(NOT_OURS);
        }
        if self.inside(caller.pid) {
            return no(INSIDE);
        }
        let program = self.program(caller, call.get("client"));
        // read again after the walks: a caller that ran another program or ended meanwhile is refused
        if !self.ours(caller) {
            return no(NOT_OURS);
        }
        if !(self.on)() {
            return no(OFF);
        }
        let Some(tool) = call.get("tool").and_then(Value::as_str).filter(|t| [LIST, READ, SEND, OPEN].contains(t)) else { return no(UNREADABLE) };
        let Some(args) = call.get("args").filter(|a| a.is_object()).cloned() else { return no(UNREADABLE) };
        let (state, _busy) = match self.enter(caller) {
            Ok(x) => x,
            Err(t) => return no(t),
        };
        if state == State::New {
            let let_in = Call { id: self.new_id(), tool: LET_IN.into(), args: json!({}), program: program.clone() };
            match self.ask(&let_in, alive) {
                Asked::Answered(r) if !r.error => self.set(caller, State::In),
                Asked::Answered(_) => {
                    self.set(caller, State::Out);
                    return no(REFUSED_RUN);
                }
                Asked::Closed(t) => return no(t),
            }
        }
        match self.ask(&Call { id: self.new_id(), tool: tool.into(), args, program }, alive) {
            Asked::Answered(r) => json!({"text": r.text, "error": r.error}).to_string(),
            Asked::Closed(t) => no(t),
        }
    }

    /// The page answers call `id`. False when no call of that id waits (it was answered already, or it is gone), so a
    /// card is settled once and a press on a closed card reaches nothing.
    pub fn reply(&self, id: &str, r: Reply) -> bool {
        let Some(tx) = self.pending.lock().unwrap().remove(id) else { return false };
        tx.send(r).is_ok()
    }

    #[cfg(test)]
    pub fn socket(&self) -> &Path {
        &self.socket
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{OnceLock, Weak};

    const APP: &str = "/Applications/Manut AI.app/Contents/MacOS/manut";
    const CURSOR_HELPER: &str = "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)";

    /// A stand-in process table: each process's identity version (what an audit token holds besides the pid, which an exec
    /// changes and a new process gets afresh), program and parent.
    struct Family {
        procs: Mutex<HashMap<i32, (u32, &'static str, i32)>>,
        versions: AtomicU64,
    }

    impl Family {
        /// The app (500), a chat it started (510) and that chat's relay (511); Claude (600) and its relay (601); Cursor's
        /// helper (700), a shell under it (701) and its relay (702); a program that speaks to the socket itself (800); a
        /// shell (900), `env` under it (901) and a relay under that (902).
        fn new() -> Family {
            let procs = [
                (500, (1, APP, 1)),
                (510, (1, "/Users/k/.local/bin/claude", 500)),
                (511, (1, APP, 510)),
                (600, (1, "/Applications/Claude.app/Contents/MacOS/Claude", 1)),
                (601, (1, APP, 600)),
                (700, (1, CURSOR_HELPER, 1)),
                (701, (1, "/bin/zsh", 700)),
                (702, (1, APP, 701)),
                (800, (1, "/usr/bin/python3", 1)),
                (900, (1, "/bin/zsh", 1)),
                (901, (1, "/usr/bin/env", 900)),
                (902, (1, APP, 901)),
            ];
            Family { procs: Mutex::new(procs.into_iter().collect()), versions: AtomicU64::new(2) }
        }

        fn caller(&self, pid: i32) -> Caller {
            let v = self.procs.lock().unwrap()[&pid].0;
            Caller { pid, token: [v, 0, 0, 0, 0, pid as u32, 0, 0] }
        }

        fn exec(&self, pid: i32, program: &'static str) {
            let v = self.versions.fetch_add(1, Ordering::Relaxed) as u32;
            let mut p = self.procs.lock().unwrap();
            let e = p.get_mut(&pid).unwrap();
            *e = (v, program, e.2);
        }

        fn spawn(&self, pid: i32, program: &'static str, parent: i32) {
            let v = self.versions.fetch_add(1, Ordering::Relaxed) as u32;
            self.procs.lock().unwrap().insert(pid, (v, program, parent));
        }

        fn end(&self, pid: i32) {
            self.procs.lock().unwrap().remove(&pid);
        }
    }

    impl Peers for Family {
        fn program(&self, c: &Caller) -> Option<PathBuf> {
            self.procs.lock().unwrap().get(&c.pid).filter(|e| e.0 == c.token[0]).map(|e| PathBuf::from(e.1))
        }
        fn own_program(&self) -> Option<PathBuf> {
            Some(PathBuf::from(APP))
        }
        fn parent(&self, pid: i32) -> Option<i32> {
            self.procs.lock().unwrap().get(&pid).map(|e| e.2)
        }
        fn pid_program(&self, pid: i32) -> Option<PathBuf> {
            self.procs.lock().unwrap().get(&pid).map(|e| PathBuf::from(e.1))
        }
    }

    /// The family, but the caller runs another program right after its first read: the second read must refuse it.
    struct Flips {
        family: Family,
        reads: AtomicU64,
        flip: i32,
    }

    impl Peers for Flips {
        fn program(&self, c: &Caller) -> Option<PathBuf> {
            let p = self.family.program(c);
            if c.pid == self.flip && self.reads.fetch_add(1, Ordering::Relaxed) == 0 {
                self.family.exec(self.flip, "/usr/bin/python3");
            }
            p
        }
        fn own_program(&self) -> Option<PathBuf> {
            self.family.own_program()
        }
        fn parent(&self, pid: i32) -> Option<i32> {
            self.family.parent(pid)
        }
        fn pid_program(&self, pid: i32) -> Option<PathBuf> {
            self.family.pid_program(pid)
        }
    }

    /// A stand-in page: what it was handed and told was gone; whether it listens; and an answer it gives at once, if any.
    #[derive(Default)]
    struct Shown {
        calls: Mutex<Vec<Call>>,
        gone: Mutex<Vec<String>>,
        deaf: bool,
        answer: Mutex<Option<Box<dyn Fn(&Call) -> Option<Reply> + Send>>>,
        door: OnceLock<Weak<Door>>,
    }

    impl Page for Shown {
        fn call(&self, c: &Call) -> bool {
            if self.deaf {
                return false;
            }
            self.calls.lock().unwrap().push(c.clone());
            let r = self.answer.lock().unwrap().as_ref().and_then(|f| f(c));
            if let (Some(r), Some(d)) = (r, self.door.get().and_then(Weak::upgrade)) {
                d.reply(&c.id, r);
            }
            true
        }
        fn gone(&self, id: &str) {
            self.gone.lock().unwrap().push(id.to_string());
        }
    }

    impl Shown {
        fn tools(&self) -> Vec<String> {
            self.calls.lock().unwrap().iter().map(|c| c.tool.clone()).collect()
        }
    }

    fn yes(t: &str) -> Reply {
        Reply { text: t.into(), error: false }
    }

    /// A page that lets every program in and answers every call with `text`.
    fn agreeable(text: &'static str) -> Arc<Shown> {
        let page = Arc::new(Shown::default());
        *page.answer.lock().unwrap() = Some(Box::new(move |c: &Call| Some(if c.tool == LET_IN { yes("") } else { yes(text) })));
        page
    }

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tm-door-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn door_with(name: &str, peers: Arc<dyn Peers>, page: Arc<Shown>, on: bool, wait: Duration) -> Arc<Door> {
        let d = Arc::new(Door::new(&dir(name), peers, page.clone(), Box::new(move || on), 500, wait).unwrap());
        let _ = page.door.set(Arc::downgrade(&d));
        d
    }

    fn line(tool: &str, args: Value) -> String {
        json!({"tool": tool, "args": args, "client": {"name": "Claude", "version": "1.0"}}).to_string()
    }

    fn ask(door: &Door, family: &Family, pid: i32, tool: &str, args: Value) -> Value {
        serde_json::from_str(&door.answer(&line(tool, args), Some(&family.caller(pid)), &|| true)).unwrap()
    }

    #[test]
    fn everything_is_refused_while_the_switch_is_off_and_the_page_hears_nothing() {
        let family = Arc::new(Family::new());
        let page = agreeable("listed");
        let door = door_with("off", family.clone(), page.clone(), false, WAIT);
        for (tool, args) in [(LIST, json!({})), (READ, json!({"chat": 1})), (SEND, json!({"chat": 1, "message": "hi"}))] {
            let r = ask(&door, &family, 601, tool, args);
            assert_eq!((r["text"].as_str(), r["error"].as_bool()), (Some(OFF), Some(true)));
        }
        assert!(page.tools().is_empty());
    }

    #[test]
    fn only_this_apps_own_relay_is_served() {
        let family = Arc::new(Family::new());
        let page = agreeable("listed");
        let door = door_with("ours", family.clone(), page.clone(), true, WAIT);
        assert_eq!(ask(&door, &family, 800, LIST, json!({}))["text"], NOT_OURS);
        assert_eq!(serde_json::from_str::<Value>(&door.answer(&line(LIST, json!({})), None, &|| true)).unwrap()["text"], NOT_OURS);
        assert!(page.tools().is_empty());
        // a relay that runs another program between the two reads of its program is refused at the second
        let flips = Arc::new(Flips { family: Family::new(), reads: AtomicU64::new(0), flip: 601 });
        let caller = flips.family.caller(601);
        let page = agreeable("listed");
        let door = door_with("flips", flips.clone(), page.clone(), true, WAIT);
        let r: Value = serde_json::from_str(&door.answer(&line(LIST, json!({})), Some(&caller), &|| true)).unwrap();
        assert_eq!(r["text"], NOT_OURS);
        assert!(page.tools().is_empty());
    }

    #[test]
    fn a_relay_started_inside_the_app_is_refused_before_any_card() {
        let family = Arc::new(Family::new());
        let page = agreeable("listed");
        let door = door_with("inside", family.clone(), page.clone(), true, WAIT);
        assert_eq!(ask(&door, &family, 511, LIST, json!({}))["text"], INSIDE);
        assert!(page.tools().is_empty());
    }

    #[test]
    fn the_program_is_named_by_the_kernel_and_its_own_words_are_only_its_own() {
        let family = Arc::new(Family::new());
        let page = agreeable("listed");
        let door = door_with("names", family.clone(), page.clone(), true, WAIT);
        let calls_itself = json!({"tool": LIST, "args": {}, "client": {"name": "Manut\u{200b} AI\n", "version": "9"}}).to_string();
        door.answer(&calls_itself, Some(&family.caller(702)), &|| true);
        let first = page.calls.lock().unwrap()[0].program.clone();
        assert_eq!(first, Program { name: "Cursor".into(), path: CURSOR_HELPER.into(), calls_itself: Some("Manut AI 9".into()) });
        ask(&door, &family, 601, LIST, json!({}));
        assert_eq!(page.calls.lock().unwrap().last().unwrap().program.name, "Claude");
        ask(&door, &family, 902, LIST, json!({}));
        let unknown = page.calls.lock().unwrap().last().unwrap().program.clone();
        assert_eq!((unknown.name.as_str(), unknown.path.as_str()), (UNKNOWN_PROGRAM, ""));
        assert_eq!(named(Path::new("/usr/local/bin/node")), "node");
    }

    #[test]
    fn a_program_is_let_in_once_per_run_and_a_no_holds_for_the_rest_of_it() {
        let family = Arc::new(Family::new());
        let page = Arc::new(Shown::default());
        *page.answer.lock().unwrap() = Some(Box::new(|c: &Call| Some(if c.tool == LET_IN { Reply { text: String::new(), error: true } } else { yes("listed") })));
        let door = door_with("letin", family.clone(), page.clone(), true, WAIT);
        assert_eq!(ask(&door, &family, 601, LIST, json!({}))["text"], REFUSED_RUN);
        assert_eq!(page.tools(), [LET_IN]);
        // the rest of that run is refused with no card
        assert_eq!(ask(&door, &family, 601, READ, json!({"chat": 1}))["text"], REFUSED_RUN);
        assert_eq!(page.tools(), [LET_IN]);
        // the program starts its server again: a new run, which asks again
        family.end(601);
        family.spawn(601, APP, 600);
        *page.answer.lock().unwrap() = Some(Box::new(|c: &Call| Some(if c.tool == LET_IN { yes("") } else { yes("1. Fix the login") })));
        let r = ask(&door, &family, 601, LIST, json!({}));
        assert_eq!((r["text"].as_str(), r["error"].as_bool()), (Some("1. Fix the login"), Some(false)));
        assert_eq!(page.tools(), [LET_IN, LET_IN, LIST]);
        // let in: the next call goes straight to its card
        ask(&door, &family, 601, READ, json!({"chat": 1}));
        assert_eq!(page.tools(), [LET_IN, LET_IN, LIST, READ]);
        assert_eq!(page.calls.lock().unwrap()[3].args, json!({"chat": 1}));
    }

    #[test]
    fn a_program_has_one_card_at_a_time() {
        let family = Arc::new(Family::new());
        let page = Arc::new(Shown::default());
        let door = door_with("one", family.clone(), page.clone(), true, Duration::from_secs(5));
        let (d, f) = (door.clone(), family.clone());
        let first = std::thread::spawn(move || ask(&d, &f, 601, LIST, json!({})));
        for _ in 0..200 {
            if !page.tools().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        // the let-in card waits: nothing else of that run is served, and nothing reaches the page
        assert_eq!(ask(&door, &family, 601, READ, json!({"chat": 1}))["text"], ONE_AT_A_TIME);
        assert_eq!(page.tools(), [LET_IN]);
        // another program is its own run, served while the first one's card waits
        *page.answer.lock().unwrap() = Some(Box::new(|c: &Call| (c.program.name == "Cursor").then(|| yes("listed"))));
        assert_eq!(ask(&door, &family, 702, LIST, json!({}))["text"], "listed");
        let id = page.calls.lock().unwrap()[0].id.clone();
        assert!(door.reply(&id, Reply { text: String::new(), error: true }));
        assert_eq!(first.join().unwrap()["text"], REFUSED_RUN);
        // a second reply to the same card reaches nothing
        assert!(!door.reply(&id, yes("")));
    }

    #[test]
    fn a_program_is_refused_past_its_calls_for_the_minute() {
        let family = Arc::new(Family::new());
        let page = agreeable("listed");
        let door = door_with("limit", family.clone(), page.clone(), true, WAIT);
        for i in 0..PER_MINUTE {
            assert_eq!(ask(&door, &family, 601, LIST, json!({}))["text"], "listed", "call {i}");
        }
        assert_eq!(ask(&door, &family, 601, LIST, json!({}))["text"], TOO_MANY);
        assert_eq!(ask(&door, &family, 702, LIST, json!({}))["text"], "listed");
    }

    #[test]
    fn a_call_its_program_gave_up_closes_its_card_and_a_late_press_reaches_nothing() {
        let family = Arc::new(Family::new());
        let page = Arc::new(Shown::default());
        *page.answer.lock().unwrap() = Some(Box::new(|c: &Call| (c.tool == LET_IN).then(|| yes(""))));
        let door = door_with("gone", family.clone(), page.clone(), true, WAIT);
        let flag = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let (d, f, f2) = (door.clone(), family.clone(), flag.clone());
        let t = std::thread::spawn(move || serde_json::from_str::<Value>(&d.answer(&line(SEND, json!({"chat": 1, "message": "hi"})), Some(&f.caller(601)), &|| f2.load(Ordering::Relaxed))).unwrap());
        for _ in 0..200 {
            if page.tools().len() == 2 {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        flag.store(false, Ordering::Relaxed);
        assert_eq!(t.join().unwrap()["text"], GONE);
        let id = page.calls.lock().unwrap()[1].id.clone();
        assert_eq!(*page.gone.lock().unwrap(), [id.clone()]);
        assert!(!door.reply(&id, yes("Sent")));
    }

    #[test]
    fn a_call_nobody_answers_closes_after_the_wait() {
        let family = Arc::new(Family::new());
        let page = Arc::new(Shown::default());
        let door = door_with("late", family.clone(), page.clone(), true, Duration::from_millis(120));
        assert_eq!(ask(&door, &family, 601, LIST, json!({}))["text"], TIMED_OUT);
        assert_eq!(page.gone.lock().unwrap().len(), 1);
        // the run is still new: the next call asks to be let in again
        ask(&door, &family, 601, LIST, json!({}));
        assert_eq!(page.tools(), [LET_IN, LET_IN]);
    }

    #[test]
    fn no_page_listening_is_said_plainly() {
        let family = Arc::new(Family::new());
        let page = Arc::new(Shown { deaf: true, ..Default::default() });
        let door = door_with("deaf", family.clone(), page.clone(), true, WAIT);
        assert_eq!(ask(&door, &family, 601, LIST, json!({}))["text"], NO_WINDOW);
    }

    #[test]
    fn a_call_that_is_not_one_of_the_four_is_unreadable() {
        let family = Arc::new(Family::new());
        let page = agreeable("listed");
        let door = door_with("unread", family.clone(), page.clone(), true, WAIT);
        let c = family.caller(601);
        for l in ["{nope".to_string(), line("approve_ask", json!({})), line(LET_IN, json!({})), json!({"tool": LIST, "args": [1]}).to_string()] {
            assert_eq!(serde_json::from_str::<Value>(&door.answer(&l, Some(&c), &|| true)).unwrap()["text"], UNREADABLE, "{l}");
        }
        assert!(page.tools().is_empty());
    }

    /// M13: whatever a call holds, no refusal carries any of it back or anywhere else.
    #[test]
    fn no_refusal_holds_anything_of_the_call() {
        let family = Arc::new(Family::new());
        let secret = "sk-ant-SECRET-WORDS-IN-A-MESSAGE";
        let args = json!({"chat": 1, "message": secret});
        let refusals = [
            (door_with("m13a", family.clone(), agreeable("x"), false, WAIT), 601),
            (door_with("m13b", family.clone(), agreeable("x"), true, WAIT), 800),
            (door_with("m13c", family.clone(), agreeable("x"), true, WAIT), 511),
            (door_with("m13d", family.clone(), Arc::new(Shown { deaf: true, ..Default::default() }), true, WAIT), 601),
            (door_with("m13e", family.clone(), Arc::new(Shown::default()), true, Duration::from_millis(60)), 702),
        ];
        for (door, pid) in refusals {
            let r = door.answer(&line(SEND, args.clone()), Some(&family.caller(pid)), &|| true);
            assert!(!r.contains("SECRET"), "{r}");
            assert_eq!(serde_json::from_str::<Value>(&r).unwrap()["error"], true);
        }
    }

    /// The real road on the Mac: the relay's own serve over a real socket to a listening door, the test as the caller (it
    /// runs the door's own program, read from the kernel), the folder and socket this user's alone, and a stale socket
    /// file replaced.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_call_goes_through_the_real_socket_and_back() {
        use std::os::unix::fs::PermissionsExt;
        let d = dir("socket");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(super::super::socket_in(&d), b"stale").unwrap();
        let page = agreeable("1. Fix the login (Claude Code, idle)");
        let door = Arc::new(Door::new(&d, Arc::new(crate::computer::hub::system::System), page.clone(), Box::new(|| true), 0, WAIT).unwrap());
        let _ = page.door.set(Arc::downgrade(&door));
        door.listen().unwrap();
        assert_eq!(std::fs::metadata(&d).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(std::fs::metadata(door.socket()).unwrap().permissions().mode() & 0o777, 0o600);
        let input = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": LIST, "arguments": {}}}).to_string();
        let out: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        struct W(Arc<Mutex<Vec<u8>>>);
        impl Write for W {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let w: Arc<Mutex<dyn Write + Send>> = Arc::new(Mutex::new(W(out.clone())));
        // the program keeps its end open until its answer has come: closing it earlier would close the call
        let answer = out.clone();
        super::super::relay::serve(super::super::relay::WaitsForAnswers::new(&input, move || answer.lock().unwrap().contains(&b'\n')), w, door.socket().to_path_buf());
        let got: Value = serde_json::from_str(String::from_utf8(out.lock().unwrap().clone()).unwrap().trim()).unwrap();
        assert_eq!(got["result"]["content"][0]["text"], "1. Fix the login (Claude Code, idle)", "{got}");
        assert_eq!(page.tools(), [LET_IN, LIST]);
        let _ = std::fs::remove_dir_all(d);
    }
}
