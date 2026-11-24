//! What keeps running: the commands this app's own terminals and chats started and that still run, each with how long it
//! has run and the ports it listens on, and Stop (docs/code-editor.md, "Watching it run"; the page is src/running/).
//!
//! Which processes are the app's own is settled in one place: [`Sessions::roots`] and [`ChatSessions::roots`], the
//! program of each session this app started. Everything here walks down from those programs, through the processes they
//! started, and reads nothing else. A Stop names a command by its session, its process id and when it started, and the
//! shell finds that process under that session again before it signals anything, so a number the page made up, a
//! process that took a finished one's number, or the session's own shell is never touched. A process's environment is
//! never kept or sent (macOS hands it over together with the arguments, and the reader steps past it), and no command
//! line leaves the shell for a process outside those trees.
//!
//! What counts as a command: under a login shell (a Shell terminal), whatever its person ran from it; under an agent (a
//! chat, or a terminal running one), only what the agent ran through its own shell (`sh -c …`). The agent's other
//! children, the MCP servers it keeps for the whole session, a language server, a helper, are not commands, and listing
//! them with a Stop would make a list nobody trusts.
//!
//! The walk is pure ([`commands`], [`to_stop`]) over the [`Procs`] it is given, so most of it is tested with a table of
//! processes the test writes. [`System`] is the real one: macOS reads with libproc, Linux with `/proc`, with no shelling
//! out. Windows has no such reader yet, so the page is told `unsupported` and draws nothing.
#![cfg_attr(not(unix), allow(dead_code))]

use std::collections::HashSet;
use std::path::PathBuf;

use serde::Serialize;

use crate::agent_chat::ChatSessions;
use crate::sessions::Sessions;

/// How deep a tree is walked, how many processes of one session are looked at, how many commands one session lists and
/// how much of a command line is sent: a runaway tree (a fork bomb, a build that starts thousands) costs a bounded look.
const MAX_DEPTH: usize = 12;
const MAX_PROCS: usize = 400;
const MAX_ROWS: usize = 40;
const MAX_ARGS: usize = 64;
const MAX_ARG_CHARS: usize = 4_096;

/// A command has this long to end after the polite signal before it is killed.
#[cfg(unix)]
const GRACE: std::time::Duration = std::time::Duration::from_secs(3);

/// What kind of session a command belongs to: a terminal (the shell's pty) or a chat (an agent on pipes). The same two
/// words the page uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Pty,
    Chat,
}

impl Kind {
    pub fn parse(word: &str) -> Option<Kind> {
        match word {
            "pty" => Some(Kind::Pty),
            "chat" => Some(Kind::Chat),
            _ => None,
        }
    }
}

/// The program of one session this app started: where the walk starts, and the folder the session started in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Root {
    pub kind: Kind,
    pub session: u32,
    pub pid: u32,
    pub folder: PathBuf,
}

/// Every session of this app that has a program running now.
#[cfg_attr(not(unix), allow(dead_code))]
pub fn roots_of(sessions: &Sessions, chats: &ChatSessions) -> Vec<Root> {
    let ptys = sessions.roots().into_iter().map(|(session, pid, folder)| Root { kind: Kind::Pty, session, pid, folder });
    let chat = chats.roots().into_iter().map(|(session, pid, folder)| Root { kind: Kind::Chat, session, pid, folder });
    ptys.chain(chat).collect()
}

/// What the system says of one process. `argv` is as the system holds it (the program first); it is empty when the
/// system would not say.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Info {
    pub exe: String,
    pub argv: Vec<String>,
    /// When it started, ms since the epoch.
    pub started: Option<u64>,
}

/// The processes of this computer, as far as the walk reads them.
pub trait Procs {
    /// The processes whose parent is `pid`.
    fn children(&self, pid: u32) -> Vec<u32>;
    /// `None` when there is no such process (any more), or the system would not say what it is.
    fn info(&self, pid: u32) -> Option<Info>;
    /// The TCP ports `pid` itself is listening on.
    fn ports(&self, pid: u32) -> Vec<u16>;
}

/// One command that still runs: the page's `RunningRow` (src/running/model.ts), field for field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Row {
    pub kind: Kind,
    pub session: u32,
    pub folder: String,
    pub pid: u32,
    pub started: Option<u64>,
    pub argv: Vec<String>,
    /// The ports it, or any process it started, listens on, lowest first.
    pub ports: Vec<u16>,
}

// ---------------------------------------------------------------------------------------------
// What is a command
// ---------------------------------------------------------------------------------------------

const SHELLS: [&str; 10] = ["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "csh", "tcsh"];

fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn is_shell(info: &Info) -> bool {
    SHELLS.contains(&file_name(&info.exe))
}

/// What a shell's own arguments say it does.
#[derive(Debug, PartialEq, Eq)]
enum Use {
    /// `-c <script>`, `-lc <script>`: a command run for someone else.
    Command,
    /// It was given a file: a program like any other.
    Script,
    /// Only options: a login shell, or a shell the person started inside one.
    Interactive,
}

/// How a shell is used, by its arguments after its own name. A cluster of letters with a `c` in it (`-c`, `-lc`, `-ic`)
/// is a command; the first word that is no option is a script; `-o` and `+o` take the option's name with them.
fn shell_use(argv: &[String]) -> Use {
    let mut i = 1;
    while i < argv.len() {
        let a = argv[i].as_str();
        let cluster = a.len() > 1 && a.starts_with('-') && !a.starts_with("--") && a[1..].chars().all(|c| c.is_ascii_alphabetic());
        if cluster && a.contains('c') {
            return Use::Command;
        }
        if !a.starts_with('-') && !a.starts_with('+') {
            return Use::Script;
        }
        if a == "-o" || a == "+o" {
            i += 1;
        }
        i += 1;
    }
    Use::Interactive
}

#[derive(Debug, PartialEq, Eq)]
enum Class {
    /// A shell a person types into: its children are what they ran.
    Launcher,
    /// A shell given a command to run: it is the command's own.
    Wrapper,
    /// A coding agent's CLI (`fg.rs` knows them): its children are its helpers, and what it ran through its own shell.
    Agent,
    /// Anything else.
    Program,
}

fn classify(info: &Info) -> Class {
    if is_shell(info) {
        return match shell_use(&info.argv) {
            Use::Command => Class::Wrapper,
            Use::Script => Class::Program,
            Use::Interactive => Class::Launcher,
        };
    }
    let argv: Vec<&str> = info.argv.iter().map(String::as_str).collect();
    let real = |p: &str| std::fs::canonicalize(p).ok().map(|r| r.to_string_lossy().into_owned());
    if crate::fg::agent_for_process(&info.exe, &argv, real).is_some() { Class::Agent } else { Class::Program }
}

/// Which children of a process are commands.
#[derive(Clone, Copy)]
enum Under {
    /// A login shell, or a shell inside one: any program its person ran.
    Shell,
    /// An agent: only a shell it gave a command to.
    Agent,
}

/// The commands under `pid`, each with what the system says of it: the processes that are the command's own, not what
/// they started (that belongs to the command).
fn walk(os: &dyn Procs, pid: u32, under: Under, depth: usize, seen: &mut HashSet<u32>, budget: &mut usize, out: &mut Vec<(u32, Info)>) {
    if depth >= MAX_DEPTH {
        return;
    }
    for child in os.children(pid) {
        if *budget == 0 {
            return;
        }
        if !seen.insert(child) {
            continue;
        }
        *budget -= 1;
        let Some(info) = os.info(child) else { continue };
        match (classify(&info), under) {
            (Class::Launcher, _) => walk(os, child, Under::Shell, depth + 1, seen, budget, out),
            (Class::Agent, _) => walk(os, child, Under::Agent, depth + 1, seen, budget, out),
            (Class::Wrapper, _) | (Class::Program, Under::Shell) => out.push((child, info)),
            (Class::Program, Under::Agent) => {}
        }
    }
}

/// The commands under one session's program. A session whose program is itself a shell (a Shell terminal) is walked as a
/// shell; any other program is an agent.
fn command_roots(os: &dyn Procs, root: u32) -> Vec<(u32, Info)> {
    let Some(info) = os.info(root) else { return Vec::new() };
    let under = if is_shell(&info) { Under::Shell } else { Under::Agent };
    let mut out = Vec::new();
    let mut seen = HashSet::from([root]);
    let mut budget = MAX_PROCS;
    walk(os, root, under, 0, &mut seen, &mut budget, &mut out);
    out.truncate(MAX_ROWS);
    out
}

/// `pid` and every process it started, the command's own first and each parent before its children. Bounded as the walk is.
fn subtree(os: &dyn Procs, pid: u32) -> Vec<u32> {
    let mut all = vec![pid];
    let mut seen = HashSet::from([pid]);
    let mut at = 0;
    while at < all.len() && all.len() < MAX_PROCS {
        for c in os.children(all[at]) {
            if all.len() < MAX_PROCS && seen.insert(c) {
                all.push(c);
            }
        }
        at += 1;
    }
    all
}

/// The ports a command listens on: its own and those of everything it started, lowest first, each once. A dev server is
/// usually a grandchild (`pnpm` starts `sh`, which starts `node`), so the port is the tree's.
fn tree_ports(os: &dyn Procs, pid: u32) -> Vec<u16> {
    let mut ports: Vec<u16> = subtree(os, pid).into_iter().flat_map(|p| os.ports(p)).collect();
    ports.sort_unstable();
    ports.dedup();
    ports
}

/// A command line as far as the page takes it.
fn capped(argv: Vec<String>) -> Vec<String> {
    argv.into_iter().take(MAX_ARGS).map(|a| if a.chars().count() > MAX_ARG_CHARS { a.chars().take(MAX_ARG_CHARS).collect() } else { a }).collect()
}

/// Every command still running under `roots`.
pub fn commands(os: &dyn Procs, roots: &[Root]) -> Vec<Row> {
    let mut rows = Vec::new();
    for root in roots {
        for (pid, info) in command_roots(os, root.pid) {
            rows.push(Row {
                kind: root.kind,
                session: root.session,
                folder: root.folder.to_string_lossy().into_owned(),
                pid,
                started: info.started,
                argv: capped(info.argv),
                ports: tree_ports(os, pid),
            });
        }
    }
    rows
}

// ---------------------------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------------------------

/// Which command to stop: the page's `RunningTarget`. The start time is what tells it from another process that took
/// its number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Target {
    pub kind: Kind,
    pub session: u32,
    pub pid: u32,
    pub started: Option<u64>,
}

/// The command `t` names, and everything it started, as they are now: `None` unless it is a command of that session still
/// running with that start time. Only a command is accepted, never a session's own program or a process deeper in a
/// command's tree, so a Stop can end nothing a list did not show. The app's own process is left out whatever the table says.
pub fn to_stop(os: &dyn Procs, roots: &[Root], t: &Target) -> Option<Vec<(u32, Info)>> {
    let root = roots.iter().find(|r| r.kind == t.kind && r.session == t.session)?;
    command_roots(os, root.pid).into_iter().find(|(pid, info)| *pid == t.pid && info.started == t.started)?;
    let me = std::process::id();
    Some(subtree(os, t.pid).into_iter().filter(|p| *p != me).filter_map(|p| os.info(p).map(|i| (p, i))).collect())
}

/// The process listed then is still the one at `pid`: a finished process's number can belong to another by now.
fn same(os: &dyn Procs, pid: u32, then: &Info) -> bool {
    os.info(pid).is_some_and(|now| now.started == then.started && now.exe == then.exe)
}

// ---------------------------------------------------------------------------------------------
// The two commands of the shell
// ---------------------------------------------------------------------------------------------

/// Every command this app's sessions started that still runs. `Err("unsupported")` where there is no reader (Windows):
/// the page then draws nothing.
pub fn list(roots: &[Root]) -> Result<Vec<Row>, String> {
    #[cfg(unix)]
    return Ok(commands(&system::System::new(), roots));
    #[cfg(not(unix))]
    {
        let _ = roots;
        Err("unsupported".into())
    }
}

/// Stop a command and what it started: `Ok("stopping")` once the polite signal (SIGTERM) is sent to each of them, top
/// down so a supervisor that would start its worker again hears first; whatever still runs after [`GRACE`] is killed. `Ok("gone")`
/// when it is not there to stop: it ended already, or it is no command of that session.
pub fn stop(roots: &[Root], t: &Target) -> Result<&'static str, String> {
    #[cfg(unix)]
    return Ok(system::stop_in(&system::System::new(), roots, t, GRACE));
    #[cfg(not(unix))]
    {
        let _ = (roots, t);
        Err("unsupported".into())
    }
}

// ---------------------------------------------------------------------------------------------
// The real processes (unix)
// ---------------------------------------------------------------------------------------------

#[cfg(unix)]
mod system {
    use std::collections::HashSet;
    use std::thread;
    use std::time::{Duration, Instant};

    use super::{same, to_stop, Info, Procs, Root, Target};

    /// How many children of one process are read.
    #[cfg(target_os = "macos")]
    const MAX_CHILDREN: usize = 256;

    /// Reads the processes of this computer. One is made for each look, so what it caches (Linux: who is whose child) is
    /// never older than the look.
    pub struct System {
        #[cfg(not(target_os = "macos"))]
        kids: std::cell::OnceCell<std::collections::HashMap<u32, Vec<u32>>>,
    }

    impl System {
        pub fn new() -> System {
            System {
                #[cfg(not(target_os = "macos"))]
                kids: std::cell::OnceCell::new(),
            }
        }
    }

    impl Procs for System {
        fn children(&self, pid: u32) -> Vec<u32> {
            #[cfg(target_os = "macos")]
            return macos::children(pid);
            #[cfg(not(target_os = "macos"))]
            return self.kids.get_or_init(linux::parent_map).get(&pid).cloned().unwrap_or_default();
        }

        fn info(&self, pid: u32) -> Option<Info> {
            let mut path = [0u8; 4096];
            let n = crate::fg::exe_path(pid, &mut path)?;
            let exe = String::from_utf8_lossy(&path[..n]).into_owned();
            let mut raw = Vec::new();
            // argv can fail to read for a moment on a loaded Mac: the process is still there, and says no words
            let argv = if crate::fg::argv_bytes(pid, &mut raw) && !raw.is_empty() { raw.split(|b| *b == 0).map(|a| String::from_utf8_lossy(a).into_owned()).collect() } else { Vec::new() };
            #[cfg(target_os = "macos")]
            let started = macos::started(pid);
            #[cfg(not(target_os = "macos"))]
            let started = linux::started(pid);
            Some(Info { exe, argv, started })
        }

        fn ports(&self, pid: u32) -> Vec<u16> {
            #[cfg(target_os = "macos")]
            return macos::listening(pid);
            #[cfg(not(target_os = "macos"))]
            return linux::listening(pid);
        }
    }

    /// SIGTERM to a command and everything it started, then, off this thread, SIGKILL to whatever is still the same
    /// process once `grace` has passed. Each process is looked at again right before each signal, so a number that went
    /// to another process in between is never signalled.
    pub fn stop_in(os: &dyn Procs, roots: &[Root], t: &Target, grace: Duration) -> &'static str {
        let Some(procs) = to_stop(os, roots, t) else { return "gone" };
        for (pid, info) in &procs {
            if same(os, *pid, info) {
                signal(*pid, libc::SIGTERM);
            }
        }
        let _ = thread::Builder::new().name("manut-running-stop".into()).spawn(move || {
            let os = System::new();
            let deadline = Instant::now() + grace;
            while Instant::now() < deadline && procs.iter().any(|(p, i)| same(&os, *p, i)) {
                thread::sleep(Duration::from_millis(25));
            }
            for (pid, info) in &procs {
                if same(&os, *pid, info) {
                    signal(*pid, libc::SIGKILL);
                }
            }
        });
        "stopping"
    }

    /// Process 0 and 1 are the system's: a signal to them is never sent from here.
    fn signal(pid: u32, sig: libc::c_int) {
        if pid > 1 {
            unsafe {
                libc::kill(pid as libc::pid_t, sig);
            }
        }
    }

    /// The `socket:[12345]` a `/proc/<pid>/fd` link reads as, as the inode.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    pub(super) fn socket_inode(link: &str) -> Option<u64> {
        link.strip_prefix("socket:[")?.strip_suffix(']')?.parse().ok()
    }

    /// The local ports of the listening sockets in a `/proc/net/tcp` (or `tcp6`) table whose inode is one of `inodes`:
    /// the rows whose state is `0A` (LISTEN), by the port after the colon of the local address, in hex.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    pub(super) fn parse_listening(table: &str, inodes: &HashSet<u64>) -> Vec<u16> {
        table
            .lines()
            .skip(1)
            .filter_map(|line| {
                let f: Vec<&str> = line.split_whitespace().collect();
                let (local, state, inode) = (f.get(1)?, f.get(3)?, f.get(9)?);
                if *state != "0A" || !inodes.contains(&inode.parse::<u64>().ok()?) {
                    return None;
                }
                u16::from_str_radix(local.rsplit_once(':')?.1, 16).ok()
            })
            .collect()
    }

    /// A process's start as `/proc/<pid>/stat` says it: field 22, in clock ticks since boot. The program's name (field 2)
    /// is in parentheses and may hold spaces and parentheses, so the fields are counted from the last `)`.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    pub(super) fn stat_start_ticks(stat: &str) -> Option<u64> {
        stat.rsplit_once(')')?.1.split_whitespace().nth(19)?.parse().ok()
    }

    #[cfg(target_os = "macos")]
    mod macos {
        /// sys/proc_info.h: `PROC_PIDFDSOCKETINFO`, and where in a `struct socket_fdinfo` (792 bytes, the same on arm64 and
        /// x86_64: checked with the SDK's own header) the socket's kind, its local port and its TCP state are. libc does
        /// not carry the structure, so it is read by offset, and a test listens on a port of its own to prove the offsets.
        const PROC_PIDFDSOCKETINFO: libc::c_int = 3;
        const SOCKET_FDINFO_SIZE: usize = 792;
        const OFF_KIND: usize = 256;
        const OFF_LOCAL_PORT: usize = 268;
        const OFF_TCP_STATE: usize = 344;
        /// `SOCKINFO_TCP` and `TSI_S_LISTEN`.
        const KIND_TCP: i32 = 2;
        const STATE_LISTEN: i32 = 1;

        pub fn children(pid: u32) -> Vec<u32> {
            let mut buf = [0 as libc::pid_t; super::MAX_CHILDREN];
            let n = unsafe { libc::proc_listchildpids(pid as libc::pid_t, buf.as_mut_ptr().cast(), std::mem::size_of_val(&buf) as libc::c_int) };
            if n <= 0 {
                return Vec::new();
            }
            buf.iter().take(n as usize).filter(|p| **p > 0).map(|p| *p as u32).collect()
        }

        /// When `pid` started, ms since the epoch (`proc_pidinfo` PROC_PIDTBSDINFO).
        pub fn started(pid: u32) -> Option<u64> {
            let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
            let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
            let n = unsafe { libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
            (n == size).then(|| info.pbi_start_tvsec * 1000 + info.pbi_start_tvusec / 1000)
        }

        /// The local port of a `socket_fdinfo` that is a TCP socket in LISTEN. The port is a network-order `u16` in an `int`.
        pub fn listener_port(buf: &[u8; SOCKET_FDINFO_SIZE]) -> Option<u16> {
            let int = |at: usize| i32::from_ne_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]]);
            (int(OFF_KIND) == KIND_TCP && int(OFF_TCP_STATE) == STATE_LISTEN).then(|| u16::from_be(int(OFF_LOCAL_PORT) as u16))
        }

        /// The TCP ports `pid` listens on: each of its sockets is read (`proc_pidinfo` PROC_PIDLISTFDS, then
        /// `proc_pidfdinfo` for each socket). Nothing is opened, and nothing is read from a socket.
        pub fn listening(pid: u32) -> Vec<u16> {
            let pid = pid as libc::c_int;
            let need = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
            if need <= 0 {
                return Vec::new();
            }
            let each = std::mem::size_of::<libc::proc_fdinfo>();
            let mut fds: Vec<libc::proc_fdinfo> = vec![unsafe { std::mem::zeroed() }; need as usize / each + 16];
            let got = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, fds.as_mut_ptr().cast(), (fds.len() * each) as libc::c_int) };
            if got <= 0 {
                return Vec::new();
            }
            fds.truncate(got as usize / each);
            let mut out = Vec::new();
            let mut buf = [0u8; SOCKET_FDINFO_SIZE];
            for fd in fds.iter().filter(|f| f.proc_fdtype == libc::PROX_FDTYPE_SOCKET as u32) {
                let n = unsafe { libc::proc_pidfdinfo(pid, fd.proc_fd, PROC_PIDFDSOCKETINFO, buf.as_mut_ptr().cast(), SOCKET_FDINFO_SIZE as libc::c_int) };
                if n as usize == SOCKET_FDINFO_SIZE {
                    out.extend(listener_port(&buf));
                }
            }
            out
        }

        #[cfg(test)]
        pub(super) const TEST_LAYOUT: (usize, usize, usize, usize, i32, i32) = (SOCKET_FDINFO_SIZE, OFF_KIND, OFF_LOCAL_PORT, OFF_TCP_STATE, KIND_TCP, STATE_LISTEN);
    }

    #[cfg(not(target_os = "macos"))]
    mod linux {
        use std::collections::{HashMap, HashSet};
        use std::sync::OnceLock;

        /// Who is whose child, from one pass over `/proc`: reading every process's parent for each question would be a
        /// pass for each process the walk looks at.
        pub fn parent_map() -> HashMap<u32, Vec<u32>> {
            let mut map: HashMap<u32, Vec<u32>> = HashMap::new();
            let Ok(dir) = std::fs::read_dir("/proc") else { return map };
            for entry in dir.flatten() {
                let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
                let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { continue };
                let parent = stat.rsplit_once(')').and_then(|(_, rest)| rest.split_whitespace().nth(1)).and_then(|f| f.parse::<u32>().ok());
                if let Some(parent) = parent {
                    map.entry(parent).or_default().push(pid);
                }
            }
            map
        }

        /// When the computer started, seconds since the epoch (`btime` of `/proc/stat`): it does not change while this runs.
        fn boot_time() -> Option<u64> {
            static BTIME: OnceLock<Option<u64>> = OnceLock::new();
            *BTIME.get_or_init(|| std::fs::read_to_string("/proc/stat").ok()?.lines().find_map(|l| l.strip_prefix("btime ")?.trim().parse::<u64>().ok()))
        }

        pub fn started(pid: u32) -> Option<u64> {
            let ticks = super::stat_start_ticks(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)?;
            let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
            (hz > 0).then(|| boot_time().map(|b| b * 1000 + ticks * 1000 / hz as u64))?
        }

        /// The TCP ports `pid` listens on: the inodes of its sockets (`/proc/<pid>/fd`), matched to the listening rows of
        /// this computer's TCP tables.
        pub fn listening(pid: u32) -> Vec<u16> {
            let Ok(dir) = std::fs::read_dir(format!("/proc/{pid}/fd")) else { return Vec::new() };
            let inodes: HashSet<u64> = dir.filter_map(|e| std::fs::read_link(e.ok()?.path()).ok()).filter_map(|l| super::socket_inode(&l.to_string_lossy())).collect();
            if inodes.is_empty() {
                return Vec::new();
            }
            let mut ports = Vec::new();
            for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
                if let Ok(text) = std::fs::read_to_string(table) {
                    ports.extend(super::parse_listening(&text, &inodes));
                }
            }
            ports
        }
    }

    #[cfg(test)]
    pub(super) fn layout() -> Option<(usize, usize, usize, usize, i32, i32)> {
        #[cfg(target_os = "macos")]
        return Some(macos::TEST_LAYOUT);
        #[cfg(not(target_os = "macos"))]
        return None;
    }

    #[cfg(all(test, target_os = "macos"))]
    pub(super) use macos::listener_port;
}

#[cfg(all(test, unix))]
use system::System;

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// A table of processes the test writes: whose child each is, what it says of itself, and what it listens on.
    #[derive(Default)]
    struct Fake {
        kids: HashMap<u32, Vec<u32>>,
        info: HashMap<u32, Info>,
        ports: HashMap<u32, Vec<u16>>,
    }

    impl Fake {
        fn add(&mut self, parent: u32, pid: u32, exe: &str, argv: &[&str], started: u64) -> &mut Fake {
            self.kids.entry(parent).or_default().push(pid);
            self.info.insert(pid, Info { exe: exe.into(), argv: argv.iter().map(|a| a.to_string()).collect(), started: Some(started) });
            self
        }
        fn listen(&mut self, pid: u32, ports: &[u16]) -> &mut Fake {
            self.ports.insert(pid, ports.to_vec());
            self
        }
    }

    impl Procs for Fake {
        fn children(&self, pid: u32) -> Vec<u32> {
            self.kids.get(&pid).cloned().unwrap_or_default()
        }
        fn info(&self, pid: u32) -> Option<Info> {
            self.info.get(&pid).cloned()
        }
        fn ports(&self, pid: u32) -> Vec<u16> {
            self.ports.get(&pid).cloned().unwrap_or_default()
        }
    }

    fn root(kind: Kind, session: u32, pid: u32) -> Root {
        Root { kind, session, pid, folder: PathBuf::from("/home/you/code/app") }
    }

    /// Claude Code's wrapper for a Bash command, as a live process list shows it.
    const CLAUDE_WRAP: &str = "source /Users/you/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval 'pnpm dev' < /dev/null && pwd -P >| /tmp/claude-1-cwd";

    /// A Shell terminal: the login shell, with what its person ran.
    fn shell_terminal() -> Fake {
        let mut f = Fake::default();
        f.info.insert(10, Info { exe: "/bin/zsh".into(), argv: vec!["-zsh".into()], started: Some(1_000) });
        f.add(10, 11, "/opt/homebrew/bin/node", &["node", "/opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs", "dev"], 2_000);
        f.add(11, 12, "/bin/sh", &["sh", "-c", "vite"], 2_010);
        f.add(12, 13, "/opt/homebrew/bin/node", &["node", "/code/app/node_modules/vite/bin/vite.js"], 2_020);
        f.listen(13, &[5173]);
        f
    }

    #[test]
    fn a_shell_terminal_lists_what_its_person_ran_with_the_ports_of_all_it_started() {
        let f = shell_terminal();
        let rows = commands(&f, &[root(Kind::Pty, 1, 10)]);
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!((r.kind, r.session, r.pid, r.started), (Kind::Pty, 1, 11, Some(2_000)));
        assert_eq!(r.argv, ["node", "/opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs", "dev"]);
        // the port is the grandchild's, and the row is the command, not the `sh` and the `node` under it
        assert_eq!(r.ports, [5173]);
        assert_eq!(r.folder, "/home/you/code/app");
    }

    #[test]
    fn a_shell_inside_a_shell_is_not_a_command_but_what_it_ran_is() {
        let mut f = shell_terminal();
        f.add(10, 14, "/bin/bash", &["bash"], 3_000);
        f.add(14, 15, "/bin/sleep", &["sleep", "30"], 3_100);
        f.add(10, 16, "/usr/bin/git", &["git", "status"], 3_200);
        f.add(10, 17, "/bin/bash", &["bash", "/code/app/build.sh"], 3_300);
        let pids: Vec<u32> = commands(&f, &[root(Kind::Pty, 1, 10)]).iter().map(|r| r.pid).collect();
        // `bash` itself, which waits for its person, is not listed: the `sleep` it ran is; a shell given a script is one
        assert_eq!(pids, [11, 15, 16, 17]);
    }

    #[test]
    fn an_agent_lists_only_what_it_ran_through_its_own_shell() {
        let mut f = Fake::default();
        f.info.insert(20, Info { exe: "/Users/you/.local/share/claude/versions/2.1.3".into(), argv: vec!["claude".into(), "--output-format".into(), "stream-json".into()], started: Some(1_000) });
        // the helpers it keeps for the whole session
        f.add(20, 21, "/opt/homebrew/bin/node", &["node", "/opt/homebrew/bin/railway", "mcp"], 1_100);
        f.add(20, 22, "/usr/bin/python3", &["python3", "/Users/you/.local/bin/headroom", "mcp"], 1_200);
        f.add(21, 28, "/bin/sh", &["sh", "-c", "railway-mcp-helper"], 1_300);
        // what it ran
        f.add(20, 23, "/bin/zsh", &["/bin/zsh", "-c", CLAUDE_WRAP], 5_000);
        f.add(23, 24, "/opt/homebrew/bin/node", &["node", "/opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs", "dev"], 5_010);
        f.listen(24, &[3000]);
        f.add(20, 25, "/usr/bin/rg", &["rg", "needle"], 6_000);
        let rows = commands(&f, &[root(Kind::Chat, 4, 20)]);
        assert_eq!(rows.iter().map(|r| r.pid).collect::<Vec<_>>(), [23]);
        assert_eq!(rows[0].kind, Kind::Chat);
        assert_eq!(rows[0].ports, [3000]);
        assert_eq!(rows[0].argv[1], "-c");
    }

    #[test]
    fn an_agent_run_from_a_shell_is_an_agent_and_not_a_command() {
        let mut f = Fake::default();
        f.info.insert(30, Info { exe: "/bin/zsh".into(), argv: vec!["-zsh".into()], started: Some(1_000) });
        f.add(30, 31, "/Users/you/.local/share/claude/versions/2.1.3", &["claude"], 2_000);
        f.add(31, 32, "/opt/homebrew/bin/node", &["node", "/opt/homebrew/bin/railway", "mcp"], 2_100);
        f.add(31, 33, "/bin/zsh", &["/bin/zsh", "-c", "pnpm test"], 4_000);
        f.add(30, 34, "/bin/sleep", &["sleep", "60"], 4_500);
        let pids: Vec<u32> = commands(&f, &[root(Kind::Pty, 1, 30)]).iter().map(|r| r.pid).collect();
        assert_eq!(pids, [33, 34]);
    }

    #[test]
    fn an_agent_started_through_a_node_script_is_one_agent_with_its_native_binary() {
        let mut f = Fake::default();
        f.info.insert(40, Info { exe: "/opt/homebrew/bin/node".into(), argv: vec!["node".into(), "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js".into()], started: Some(1_000) });
        f.add(40, 41, "/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex", &["codex"], 1_100);
        f.add(41, 42, "/bin/zsh", &["/bin/zsh", "-lc", "pnpm test"], 3_000);
        let rows = commands(&f, &[root(Kind::Chat, 2, 40)]);
        assert_eq!(rows.iter().map(|r| r.pid).collect::<Vec<_>>(), [42]);
    }

    #[test]
    fn the_flags_of_a_shell_tell_a_command_from_a_script_from_a_login_shell() {
        let words = |a: &[&str]| a.iter().map(|w| w.to_string()).collect::<Vec<_>>();
        for (argv, want) in [
            (&["zsh", "-c", "ls"][..], Use::Command),
            (&["bash", "-lc", "ls"][..], Use::Command),
            (&["sh", "-ic", "ls"][..], Use::Command),
            (&["bash", "-l", "-c", "ls"][..], Use::Command),
            (&["bash", "-o", "errexit", "-c", "ls"][..], Use::Command),
            (&["bash", "build.sh", "-c"][..], Use::Script),
            (&["bash", "-x", "build.sh"][..], Use::Script),
            (&["-zsh"][..], Use::Interactive),
            (&["zsh", "-l"][..], Use::Interactive),
            (&["bash", "--login", "--norc"][..], Use::Interactive),
            (&["bash", "-o", "vi"][..], Use::Interactive),
        ] {
            assert_eq!(shell_use(&words(argv)), want, "{argv:?}");
        }
    }

    #[test]
    fn ports_are_those_of_the_whole_command_lowest_first_each_once() {
        let mut f = shell_terminal();
        f.listen(11, &[24678, 5173]);
        f.listen(12, &[5173]);
        assert_eq!(commands(&f, &[root(Kind::Pty, 1, 10)])[0].ports, [5173, 24678]);
    }

    #[test]
    fn a_session_whose_program_is_gone_lists_nothing() {
        let f = shell_terminal();
        assert!(commands(&f, &[root(Kind::Pty, 1, 999)]).is_empty());
    }

    #[test]
    fn a_tree_that_loops_or_runs_away_is_looked_at_in_a_bounded_way() {
        let mut f = Fake::default();
        f.info.insert(10, Info { exe: "/bin/zsh".into(), argv: vec!["-zsh".into()], started: Some(1) });
        // a child that is its own ancestor's parent, and a thousand siblings
        f.add(10, 11, "/bin/sleep", &["sleep", "1"], 2);
        f.kids.entry(11).or_default().push(10);
        for n in 0..1_000 {
            f.add(10, 100 + n, "/bin/sleep", &["sleep", "2"], 3 + n as u64);
        }
        let rows = commands(&f, &[root(Kind::Pty, 1, 10)]);
        assert_eq!(rows.len(), MAX_ROWS);
        // a chain deeper than the walk goes
        let mut chain = Fake::default();
        chain.info.insert(1_000, Info { exe: "/bin/zsh".into(), argv: vec!["zsh".into()], started: Some(1) });
        let mut parent = 1_000;
        for n in 1..=(MAX_DEPTH as u32 + 5) {
            chain.add(parent, 1_000 + n, "/bin/bash", &["bash"], 1 + n as u64);
            parent = 1_000 + n;
        }
        chain.add(parent, 9_999, "/bin/sleep", &["sleep", "3"], 99);
        assert!(commands(&chain, &[root(Kind::Pty, 1, 1_000)]).is_empty());
    }

    #[test]
    fn a_command_line_is_cut_where_the_page_takes_it() {
        let mut f = Fake::default();
        f.info.insert(10, Info { exe: "/bin/zsh".into(), argv: vec!["-zsh".into()], started: Some(1) });
        let many: Vec<String> = std::iter::once("tool".to_string()).chain((0..200).map(|n| format!("--a{n}"))).collect();
        f.info.insert(11, Info { exe: "/usr/bin/tool".into(), argv: many, started: Some(2) });
        f.kids.insert(10, vec![11]);
        f.add(10, 12, "/usr/bin/tool", &["tool"], 3);
        f.info.get_mut(&12).unwrap().argv.push("é".repeat(MAX_ARG_CHARS * 2));
        let rows = commands(&f, &[root(Kind::Pty, 1, 10)]);
        assert_eq!(rows[0].argv.len(), MAX_ARGS);
        assert_eq!(rows[1].argv[1].chars().count(), MAX_ARG_CHARS);
    }

    #[test]
    fn a_row_is_the_json_the_page_reads() {
        // The file the page's own test reads too (src/running/host.test.ts), so neither side can change the shape alone.
        let want: serde_json::Value = serde_json::from_str(include_str!("../tests/fixtures/running-rows.json")).unwrap();
        let folder = || "/home/you/code/baanmali-preorder".to_string();
        let rows = vec![
            Row {
                kind: Kind::Pty,
                session: 7,
                folder: folder(),
                pid: 4242,
                started: Some(1_795_491_078_871),
                argv: ["node", "/opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs", "dev"].map(String::from).to_vec(),
                ports: vec![3000, 24678],
            },
            Row { kind: Kind::Chat, session: 2, folder: folder(), pid: 4400, started: None, argv: ["/bin/zsh", "-c", "vitest --watch"].map(String::from).to_vec(), ports: vec![] },
        ];
        assert_eq!(serde_json::to_value(&rows).unwrap(), want);
        assert_eq!(Kind::parse("pty"), Some(Kind::Pty));
        assert_eq!(Kind::parse("chat"), Some(Kind::Chat));
        assert_eq!(Kind::parse("tab"), None);
    }

    // ---- Stop, by the table -------------------------------------------------------------------

    fn target(kind: Kind, session: u32, pid: u32, started: Option<u64>) -> Target {
        Target { kind, session, pid, started }
    }

    #[test]
    fn stop_takes_a_listed_command_and_everything_it_started_parent_first() {
        let f = shell_terminal();
        let got = to_stop(&f, &[root(Kind::Pty, 1, 10)], &target(Kind::Pty, 1, 11, Some(2_000))).unwrap();
        assert_eq!(got.iter().map(|(p, _)| *p).collect::<Vec<_>>(), [11, 12, 13]);
    }

    #[test]
    fn stop_takes_nothing_a_list_did_not_show() {
        let f = shell_terminal();
        let roots = [root(Kind::Pty, 1, 10), root(Kind::Chat, 1, 999)];
        let ok = target(Kind::Pty, 1, 11, Some(2_000));
        assert!(to_stop(&f, &roots, &ok).is_some());
        // another session, or another kind of session with the same number
        assert!(to_stop(&f, &roots, &Target { session: 2, ..ok }).is_none());
        assert!(to_stop(&f, &roots, &Target { kind: Kind::Chat, ..ok }).is_none());
        // the same number from another run of a command: it started at another time
        assert!(to_stop(&f, &roots, &Target { started: Some(2_001), ..ok }).is_none());
        assert!(to_stop(&f, &roots, &Target { started: None, ..ok }).is_none());
        // the session's own shell, a process deeper in the command, and one under no session at all
        assert!(to_stop(&f, &roots, &target(Kind::Pty, 1, 10, Some(1_000))).is_none());
        assert!(to_stop(&f, &roots, &target(Kind::Pty, 1, 13, Some(2_020))).is_none());
        assert!(to_stop(&f, &roots, &target(Kind::Pty, 1, 4_242, Some(2_000))).is_none());
        // no sessions: nothing
        assert!(to_stop(&f, &[], &ok).is_none());
    }

    #[test]
    fn stop_never_takes_the_app_itself_even_if_a_table_says_it_runs_under_a_command() {
        let mut f = shell_terminal();
        let me = std::process::id();
        f.add(13, me, "/app/manut", &["manut"], 9_000);
        let got = to_stop(&f, &[root(Kind::Pty, 1, 10)], &target(Kind::Pty, 1, 11, Some(2_000))).unwrap();
        assert!(!got.iter().any(|(p, _)| *p == me));
    }

    #[test]
    fn a_process_is_the_one_listed_only_while_it_has_the_same_program_and_start() {
        let f = shell_terminal();
        let then = f.info(11).unwrap();
        assert!(same(&f, 11, &then));
        // its number went to another process: another start, or another program
        assert!(!same(&f, 11, &Info { started: Some(1), ..then.clone() }));
        assert!(!same(&f, 11, &Info { exe: "/bin/other".into(), ..then.clone() }));
        // it is gone
        assert!(!same(&f, 4_242, &then));
    }

    #[cfg(unix)]
    mod real {
        use super::super::*;
        use std::process::{Child, Command, Stdio};
        use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

        fn wait_for<T>(what: &str, mut f: impl FnMut() -> Option<T>) -> T {
            let until = Instant::now() + Duration::from_secs(10);
            loop {
                if let Some(v) = f() {
                    return v;
                }
                assert!(Instant::now() < until, "gave up waiting for {what}");
                std::thread::sleep(Duration::from_millis(40));
            }
        }

        fn sh(script: &str) -> Child {
            Command::new("/bin/sh").args(["-c", script]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap()
        }

        fn root_of(child: &Child) -> Root {
            Root { kind: Kind::Pty, session: 1, pid: child.id(), folder: PathBuf::from("/tmp") }
        }

        /// Everything under `child`, and `child`, ended: a test leaves nothing running.
        fn reap(mut child: Child) {
            for p in subtree(&look(), child.id()) {
                unsafe { libc::kill(p as libc::pid_t, libc::SIGKILL) };
            }
            let _ = child.kill();
            let _ = child.wait();
        }

        /// A new look at the computer's processes. A `System` keeps who is whose child (on Linux) for as long as it lives, so
        /// each look that waits for a process to appear takes a new one.
        fn look() -> System {
            System::new()
        }

        fn alive(pid: u32) -> bool {
            look().info(pid).is_some()
        }

        #[test]
        fn roots_name_terminals_and_chats_apart_though_their_numbers_may_match() {
            let tmp = std::env::temp_dir().canonicalize().unwrap();
            let sessions = Sessions::default();
            let chats = ChatSessions::default();
            let pty = sessions.spawn(vec!["/bin/sh".into(), "-c".into(), "sleep 66".into()], &tmp, None, &[], 80, 24, |_| {}).unwrap();
            let chat = chats.spawn(vec!["/bin/sh".into(), "-c".into(), "trap '' HUP; sleep 67".into()], &tmp, None, &[], Box::new(crate::agent_chat::Claude::default()), |_| {}).unwrap();
            // each table counts from one, so the same number can be a terminal and a chat: the kind tells them apart
            let roots = roots_of(&sessions, &chats);
            assert_eq!(roots.iter().map(|r| (r.kind, r.session)).collect::<Vec<_>>(), [(Kind::Pty, pty), (Kind::Chat, chat)]);
            assert!(roots.iter().all(|r| r.pid > 1 && r.folder == tmp), "{roots:?}");
            sessions.close_all();
            chats.close_all();
            assert!(roots_of(&sessions, &chats).is_empty());
        }

        #[test]
        fn reads_a_real_command_under_a_real_session_with_its_arguments_and_start() {
            let session = sh("sleep 61 & wait");
            let root = root_of(&session);
            let row = wait_for("the sleep", || commands(&look(), std::slice::from_ref(&root)).into_iter().find(|r| r.argv.get(1).is_some_and(|a| a == "61")));
            assert!(row.argv[0].ends_with("sleep"), "{:?}", row.argv);
            assert!(row.ports.is_empty());
            let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
            let started = row.started.expect("the system says when it started");
            assert!(now >= started.saturating_sub(2_000) && now - started.min(now) < 20_000, "started {started}, now {now}");
            reap(session);
        }

        #[test]
        fn reads_the_port_this_process_listens_on_and_not_a_connection_to_it() {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let client = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            let (_peer, _) = listener.accept().unwrap();
            let ports = System::new().ports(std::process::id());
            assert!(ports.contains(&port), "{ports:?} should hold {port}");
            // the connection's own end is no listener
            let own = client.local_addr().unwrap().port();
            assert!(!ports.contains(&own), "{ports:?} must not hold the client's {own}");
            drop(client);
            drop(listener);
            assert!(!System::new().ports(std::process::id()).contains(&port));
        }

        #[test]
        fn reads_the_port_of_a_server_a_command_started_two_levels_down() {
            if Command::new("python3").arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| !s.success()).unwrap_or(true) {
                eprintln!("no python3 here: skipped");
                return;
            }
            let dir = std::env::temp_dir().join(format!("manut-running-port-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let file = dir.join("port");
            let py = "import socket,sys,time; s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); open(sys.argv[1],'w').write(str(s.getsockname()[1])); time.sleep(60)";
            // session shell, then a script (a command), then the server under it
            let session = sh(&format!("sh -c \"python3 -c \\\"{py}\\\" {}; true\" & wait", file.display()));
            let port: u16 = wait_for("the server's port", || std::fs::read_to_string(&file).ok()?.trim().parse().ok());
            let root = root_of(&session);
            let row = wait_for("the command with the port", || commands(&look(), std::slice::from_ref(&root)).into_iter().find(|r| r.ports.contains(&port)));
            assert_eq!(row.ports, [port]);
            reap(session);
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn stops_a_command_and_what_it_started_and_nothing_else() {
            // the command is a shell given a script that starts a `sleep`; a sibling command and a stranger must live
            let session = sh("sh -c 'sleep 62; true' & sleep 63 & wait");
            let stranger = sh("sleep 64");
            let roots = [root_of(&session)];
            let (wrapper, sleeper) = wait_for("both commands", || {
                let os = look();
                let rows = commands(&os, &roots);
                let w = rows.iter().find(|r| r.argv.get(1).is_some_and(|a| a == "-c"))?.clone();
                let s = rows.iter().find(|r| r.argv.get(1).is_some_and(|a| a == "63"))?.clone();
                // the wrapper's own `sleep` must be there before it is stopped
                (!w.ports.is_empty() || subtree(&os, w.pid).len() > 1).then_some((w, s))
            });
            let inner: Vec<u32> = subtree(&look(), wrapper.pid);
            assert!(inner.len() >= 2, "{inner:?}");
            let t = Target { kind: Kind::Pty, session: 1, pid: wrapper.pid, started: wrapper.started };
            assert_eq!(system::stop_in(&look(), &roots, &t, Duration::from_millis(300)), "stopping");
            wait_for("the command and its sleep to end", || inner.iter().all(|p| !alive(*p)).then_some(()));
            assert!(alive(sleeper.pid), "the sibling command was left alone");
            assert!(alive(stranger.id()), "a process under no session was left alone");
            assert!(alive(session.id()), "the session's own program was left alone");
            // again: it is not there
            assert_eq!(system::stop_in(&look(), &roots, &t, Duration::from_millis(300)), "gone");
            reap(session);
            reap(stranger);
        }

        #[test]
        fn a_stale_start_time_stops_nothing() {
            let session = sh("sleep 65 & wait");
            let roots = [root_of(&session)];
            let row = wait_for("the sleep", || commands(&look(), &roots).into_iter().find(|r| r.argv.get(1).is_some_and(|a| a == "65")));
            let stale = Target { kind: Kind::Pty, session: 1, pid: row.pid, started: row.started.map(|s| s + 1) };
            assert_eq!(system::stop_in(&look(), &roots, &stale, Duration::from_millis(100)), "gone");
            std::thread::sleep(Duration::from_millis(400));
            assert!(alive(row.pid));
            reap(session);
        }

        #[test]
        fn a_command_that_ignores_the_polite_signal_is_killed_after_the_grace() {
            let session = sh("sh -c 'trap \"\" TERM; while true; do sleep 1; done' & wait");
            let roots = [root_of(&session)];
            let row = wait_for("the looping command", || commands(&look(), &roots).into_iter().find(|r| r.argv.get(1).is_some_and(|a| a == "-c")));
            // give its shell time to set the trap before the signal
            std::thread::sleep(Duration::from_millis(300));
            let t = Target { kind: Kind::Pty, session: 1, pid: row.pid, started: row.started };
            assert_eq!(system::stop_in(&look(), &roots, &t, Duration::from_millis(400)), "stopping");
            wait_for("the kill", || (!alive(row.pid)).then_some(()));
            reap(session);
        }
    }

    // ---- the readers' parsers (any unix) --------------------------------------------------------

    #[cfg(unix)]
    mod parsers {
        use super::super::system::{parse_listening, socket_inode, stat_start_ticks};
        use std::collections::HashSet;

        #[test]
        fn a_proc_link_names_a_socket_by_its_inode() {
            assert_eq!(socket_inode("socket:[12345]"), Some(12345));
            for no in ["pipe:[1]", "/dev/null", "socket:[x]", "socket:[12", "anon_inode:[eventpoll]"] {
                assert_eq!(socket_inode(no), None, "{no}");
            }
        }

        #[test]
        fn the_listening_rows_of_a_tcp_table_that_belong_to_the_given_sockets_give_their_ports() {
            let table = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
                \x20  0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 ffff 100 0 0 10 0\n\
                \x20  1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 99999 1 ffff 100 0 0 10 0\n\
                \x20  2: 0100007F:C350 0100007F:0BB8 01 00000000:00000000 00:00000000 00000000  1000        0 55555 1 ffff 100 0 0 10 0\n\
                \x20  3: 00000000000000000000000001000000:1771 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 777 1 ffff 100 0 0 10 0\n";
            let ours: HashSet<u64> = HashSet::from([12345, 55555, 777]);
            // 0BB8 is 3000, 1771 is 6001; the connection (state 01) is no listener and 99999 is another process's
            assert_eq!(parse_listening(table, &ours), [3000, 6001]);
            assert!(parse_listening(table, &HashSet::new()).is_empty());
            assert!(parse_listening("", &ours).is_empty());
            assert!(parse_listening("header only\n", &ours).is_empty());
            assert!(parse_listening("  sl\n garbage line\n 0: x\n", &ours).is_empty());
        }

        #[test]
        fn a_start_time_is_the_22nd_field_counted_from_the_last_parenthesis() {
            let stat = "1234 (node) S 1 1234 1234 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 12345678 1000 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0";
            assert_eq!(stat_start_ticks(stat), Some(987_654));
            // a name with spaces and parentheses in it
            let odd = "99 (my (weird) name) R 1 99 99 0 -1 4194560 1 0 0 0 1 2 0 0 20 0 1 0 424242 1 1 1";
            assert_eq!(stat_start_ticks(odd), Some(424_242));
            assert_eq!(stat_start_ticks("1 (short) S 1"), None);
            assert_eq!(stat_start_ticks("no parenthesis at all"), None);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_macos_socket_is_read_by_the_offsets_of_the_sdks_own_structure() {
        use super::system::{layout, listener_port};
        let (size, kind, port, state, tcp, listen) = layout().unwrap();
        let mut buf = [0u8; 792];
        assert_eq!(buf.len(), size);
        let put = |buf: &mut [u8; 792], at: usize, v: i32| buf[at..at + 4].copy_from_slice(&v.to_ne_bytes());
        put(&mut buf, kind, tcp);
        put(&mut buf, state, listen);
        // port 3000 as the network sends it: 0x0BB8, big end first, in the int's low two bytes
        put(&mut buf, port, i32::from(u16::from_ne_bytes(3000u16.to_be_bytes())));
        assert_eq!(listener_port(&buf), Some(3000));
        // a TCP socket that is not listening, a socket of another kind, and a listener of another kind
        let mut not_listening = buf;
        put(&mut not_listening, state, 4);
        assert_eq!(listener_port(&not_listening), None);
        let mut udp = buf;
        put(&mut udp, kind, 1);
        assert_eq!(listener_port(&udp), None);
        assert_eq!(listener_port(&[0u8; 792]), None);
    }
}
