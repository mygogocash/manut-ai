//! The code editor's preview (docs/code-editor.md, "The preview of a lane"; the page is src/code/previewRun.ts and
//! previewStore.ts): a lane's project started with its own dev server, in the lane's own folder, so the developer sees what
//! Kit made in their browser without starting anything by hand.
//!
//! What runs is chosen by the page, from the lane folder's `package.json` and the names at its root, which [`read`] reads
//! (`@manut/preview-command`, which never chooses a script that looks like it publishes, nor one whose pre or post script
//! does). The shell runs it only when it is one of the sixteen commands that can be chosen (`pnpm`, `yarn`, `bun` or `npm`,
//! then `run`, then `dev`, `start`, `preview` or `serve`), only while the folder's `package.json` is still the very text the
//! page chose from, and only in a lane's own folder under `~/.manut/lanes` (lane.rs), never in the developer's own folder,
//! which can hold a real `.env.local`. The program is found on the folders a chat's agent is found on
//! (`sessions::host_dirs`) and started with its arguments as a list, never through a shell.
//!
//! What it runs with: an environment that starts empty. A dev server needs a few variables to run at all, and those are the
//! only ones taken from the app's own: `PATH` as a chat gets it, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG` and the
//! `LC_*` ones. `TERM` is `dumb`, since the output goes to a pipe that the page reads as plain lines. Then each secret the
//! preview knows of is set to the value the page sends (`previewEnv`: a sample, unless the owner added that very secret), set
//! explicitly so that it wins over a `.env` file a framework loads (Vite, Next.js and dotenv leave a variable that is already
//! set alone). Nothing else of the app's environment reaches it: not a key the person exported in their shell, not the app's
//! own settings.
//!
//! Output: stdout's and stderr's lines go to the page as they come, a few at a time, and are kept nowhere here: not past the
//! batch they travel in, not on disk, not in a log. The page keeps the last lines it shows.
//!
//! Stop ends the program's process group, as a chat's close does: a hang-up to the group, and a kill after a grace. So do the
//! lane's session closing (the page asks), a reload of the page (`preview_close_all`) and the app quitting
//! ([`Previews::close_all`]). What keeps running lists each preview as a kind of its own (running.rs `Kind::Preview`).
//!
//! Its page: the page draws the preview's address in a frame beside the lane (src/code/previewFrame.ts), and the app's
//! window lets itself and its frames load only its own pages and addresses of this computer ([`app_window_may_load`], which
//! lib.rs makes the main window's navigation hook). Open and the frame keep one rule for what an address of this computer
//! is ([`loopback_url`]), tested on the page's own table (src/code/__fixtures__/loopback.json).
#![cfg_attr(not(unix), allow(dead_code))]

use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::lane;
use crate::sessions::{signal_group, ProcessTree};

/// The package managers a preview may be started with, and the scripts: the same lists as `@manut/preview-command`
/// (packages/preview-command/src/index.ts), so a command the page could not have chosen is refused here.
pub const MANAGERS: [&str; 4] = ["pnpm", "yarn", "bun", "npm"];
pub const SCRIPTS: [&str; 4] = ["dev", "start", "preview", "serve"];

/// The largest `package.json` read: a big one is a few tens of KiB. One past this is sent as unreadable.
const PACKAGE_MAX: u64 = 512 * 1024;
/// The largest `.env.example` read; a bigger one gives no samples.
const ENV_EXAMPLE_MAX: u64 = 64 * 1024;
/// The most names at a folder's root sent: the page looks only for a lockfile among them.
const NAMES_MAX: usize = 1_000;
/// The most secrets one start takes, the longest name and the longest value.
const SECRETS_MAX: usize = 200;
const SECRET_NAME_MAX: usize = 128;
const SECRET_VALUE_MAX: usize = 4_096;
/// A line longer than this (a minified bundle printed whole) is cut here, and the rest of it up to its end is dropped.
const LINE_BYTES: usize = 4_096;
/// Lines go to the page this often, and at most this many at once: the page keeps far fewer, so a flood is cut to its end.
const BATCH_EVERY: Duration = Duration::from_millis(50);
const BATCH_MAX: usize = 500;
/// How long a preview has to end after the hang-up before it is killed: a chat's close gives its agent as long.
const GRACE: Duration = Duration::from_millis(1_500);
/// When the app quits, or the page reloads, everything goes sooner.
const GRACE_ALL: Duration = Duration::from_millis(400);

/// What a lane's folder holds for the page to choose a command from: its `package.json` (none: there is no such file; empty:
/// one that could not be read, a link, too big or not text, which the page reads as unreadable), the names at its root, and
/// its `.env.example` (none: there is none to read).
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub package_json: Option<String>,
    pub files: Vec<String>,
    pub env_example: Option<String>,
}

/// What a running preview hands the page: lines it printed (stdout and stderr, in the order they arrived), and once, how it
/// ended: its exit code (none: a signal ended it) and whether the shell stopped it (Stop, the session closing, a reload, the
/// app quitting) rather than it ending by itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreviewOut {
    Lines(Vec<String>),
    Exit { code: Option<i32>, stopped: bool },
}

// ---------------------------------------------------------------------------------------------
// The checks, pure
// ---------------------------------------------------------------------------------------------

/// `cwd` as a real path, when it is a lane's own folder or a folder inside one: two names or more below `~/.manut/lanes`
/// (lane.rs `in_a_lane`), read after every link is followed, so a link there that points at the developer's folder is not a
/// lane's. `not_a_lane` otherwise.
pub fn lane_folder(home: &Path, cwd: &Path) -> Result<PathBuf, String> {
    let refuse = || "not_a_lane".to_string();
    if !cwd.is_absolute() {
        return Err(refuse());
    }
    let real = fs::canonicalize(cwd).map_err(|_| refuse())?;
    let lanes = fs::canonicalize(lane::lanes_dir(home)).map_err(|_| refuse())?;
    let rest = real.strip_prefix(&lanes).map_err(|_| refuse())?;
    let deep = rest.components().count() >= 2 && rest.components().all(|c| matches!(c, Component::Normal(_)));
    if !deep || !real.is_dir() {
        return Err(refuse());
    }
    Ok(real)
}

/// The manager and the script of `argv`, when it is exactly `[manager, "run", script]` from the two lists. Anything else,
/// a path for the program, another word, one more argument, is `bad_command`: the page chose it, and a page that sends
/// something else is not running a preview.
pub fn check_argv(argv: &[String]) -> Result<(&'static str, &'static str), String> {
    let bad = || "bad_command".to_string();
    let [manager, run, script] = argv else { return Err(bad()) };
    let manager = MANAGERS.iter().find(|m| *m == manager).ok_or_else(bad)?;
    let script = SCRIPTS.iter().find(|s| *s == script).ok_or_else(bad)?;
    if run != "run" {
        return Err(bad());
    }
    Ok((manager, script))
}

/// The variables a dev server needs to run, taken from the app's own environment when it has them. `PATH` and `TERM` are
/// the shell's own (see [`preview_env`]).
const PASSED: [&str; 6] = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG"];

/// A locale category (`LC_ALL`, `LC_CTYPE`, …): passed on like `LANG`, so a dev server prints in the person's own form.
fn is_locale(name: &str) -> bool {
    name.strip_prefix("LC_").is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_uppercase() || b == b'_'))
}

/// The names a secret may not have: the ones the preview needs to run with the shell's own values, and the loader's
/// (`DYLD_*`, `LD_*`), which choose what a program loads before it runs. The page never sends one (`previewSecrets` leaves
/// them out); one that arrives anyway refuses the start rather than starting with a part of what was asked.
fn reserved(name: &str) -> bool {
    PASSED.contains(&name) || name == "PATH" || name == "TERM" || is_locale(name) || name.starts_with("DYLD_") || name.starts_with("LD_")
}

/// Whether each secret can be set as it is: a variable's name (a letter or `_`, then letters, digits and `_`), not
/// [`reserved`], a value with no NUL in it, and not too many or too long. `bad_env` otherwise.
pub fn check_secrets(secrets: &[(String, String)]) -> Result<(), String> {
    let bad = || "bad_env".to_string();
    if secrets.len() > SECRETS_MAX {
        return Err(bad());
    }
    for (name, value) in secrets {
        let mut bytes = name.bytes();
        let first = bytes.next().is_some_and(|b| b.is_ascii_alphabetic() || b == b'_');
        let named = first && name.len() <= SECRET_NAME_MAX && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_');
        if !named || reserved(name) || value.len() > SECRET_VALUE_MAX || value.contains('\0') {
            return Err(bad());
        }
    }
    Ok(())
}

/// The whole environment a preview starts with, from `app` (the app's own environment, as pairs), the `path` a chat would
/// get and the checked `secrets`: [`PASSED`] and the locale categories when the app has them, `LANG` as a chat gets it
/// when the app has none, `TERM=dumb`, `PATH`, and then each secret, which nothing else here can name. In name order.
pub fn preview_env(app: &[(OsString, OsString)], path: OsString, secrets: &[(String, String)]) -> Vec<(OsString, OsString)> {
    let mut env: BTreeMap<OsString, OsString> = BTreeMap::new();
    for (name, value) in app {
        let Some(n) = name.to_str() else { continue };
        if PASSED.contains(&n) || is_locale(n) {
            env.insert(name.clone(), value.clone());
        }
    }
    // A Mac app started from the Finder has no LANG; a chat's agent then gets this one, and so does a preview.
    env.entry("LANG".into()).or_insert_with(|| "en_US.UTF-8".into());
    env.insert("TERM".into(), "dumb".into());
    env.insert("PATH".into(), path);
    for (name, value) in secrets {
        env.insert(name.into(), value.into());
    }
    env.into_iter().collect()
}

/// `PATH` as a chat's agent gets it (`sessions::launch_for`): the program's own folder first, so a `#!/usr/bin/env node`
/// script beside it finds the Node it came with, then the folders it was looked for on.
fn child_path(program: &Path, dirs: &[PathBuf]) -> Result<OsString, String> {
    let mut all: Vec<PathBuf> = program.parent().map(|p| vec![p.to_path_buf()]).unwrap_or_default();
    all.extend(dirs.iter().cloned());
    std::env::join_paths(all.iter().filter(|d| d.is_dir())).map_err(|e| e.to_string())
}

/// The path of `url` when it is on an address of this computer, as `@manut/dev-url` shows one: `http` or `https`, then
/// `localhost`, `127.0.0.1` or `[::1]`, a port or none, and then the path, which starts at the first `/`. None otherwise: no
/// other host, no sign-in part (`localhost@evil.example`), no space, no look-alike (`localhost.evil.example`).
fn loopback_path(url: &str) -> Option<&str> {
    let rest = url.strip_prefix("http://").or_else(|| url.strip_prefix("https://"))?;
    let (authority, path) = rest.split_at(rest.find('/')?);
    // the host, and what follows it: nothing, or `:` and the port
    let (host, port) = match authority.strip_prefix("[::1]") {
        Some(after) => ("[::1]", after),
        None => authority.split_at(authority.find(':').unwrap_or(authority.len())),
    };
    if !matches!(host, "localhost" | "127.0.0.1" | "[::1]") {
        return None;
    }
    let port_ok = match port.strip_prefix(':') {
        None => port.is_empty(),
        Some(digits) => (1..=5).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit()) && digits.parse::<u32>().is_ok_and(|p| (1..=65_535).contains(&p)),
    };
    port_ok.then_some(path)
}

/// Whether `url` is an address of this computer that a preview printed, as `@manut/dev-url` shows one: [`loopback_path`]'s
/// rule, and a closing `/` with nothing after it. Open sends that and only that to the browser, and the page puts that and only
/// that in the frame beside a lane (src/code/previewFrame.ts `loopbackUrl`, tested on the same table).
pub fn loopback_url(url: &str) -> bool {
    loopback_path(url) == Some("/")
}

/// `url` is `base` or a page under it: nothing more of the host or port may follow (`tauri://localhost.evil` is not).
fn under(url: &str, base: &str) -> bool {
    url.strip_prefix(base).is_some_and(|rest| rest.is_empty() || rest.starts_with(['/', '?', '#']))
}

/// Whether the app's own window may load `url`, in itself or in one of its frames: the app's own pages (`tauri://localhost`
/// on macOS and Linux, `http(s)://tauri.localhost` on Windows, and in a debug build the dev server, which is on this computer),
/// an empty frame (`about:blank`, `about:srcdoc`), or a page on an address of this computer by [`loopback_path`]'s rule, which
/// is where the frame beside a lane shows a preview's page and where a dev server's own pages lead. Nothing else: a link in
/// the preview's page to another site, or anything that would take the window away from the app, is cancelled here. The
/// navigation hook is told only the address, not whether the window or a frame is moving, so this one rule is the frame's
/// and the window's; the frame's sandbox keeps the window out of its reach, and the app's CSP lets a frame load only
/// localhost (tauri.conf.json `frame-src`), never the app's own pages.
pub fn app_window_may_load(url: &str) -> bool {
    matches!(url.split(['?', '#']).next(), Some("about:blank" | "about:srcdoc"))
        || under(url, "tauri://localhost")
        || under(url, "http://tauri.localhost")
        || under(url, "https://tauri.localhost")
        || loopback_path(url).is_some()
}

// ---------------------------------------------------------------------------------------------
// Reading a lane's folder
// ---------------------------------------------------------------------------------------------

/// A small file's text: none when there is no such file; `Err` when it is there but is a link, not a plain file, larger
/// than `max`, or not text. A link is never followed: Kit could point one at a file outside the lane.
fn read_small(path: &Path, max: u64) -> Result<Option<String>, ()> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    };
    if !meta.file_type().is_file() || meta.len() > max {
        return Err(());
    }
    let mut text = String::new();
    fs::File::open(path).and_then(|f| f.take(max + 1).read_to_string(&mut text)).map_err(|_| ())?;
    if text.len() as u64 > max {
        return Err(());
    }
    Ok(Some(text))
}

/// The folder's `package.json` as the page reads it: its text, none when there is none, and empty when it is there but
/// cannot be read (the page then says it could not read it).
fn package_of(dir: &Path) -> Option<String> {
    match read_small(&dir.join("package.json"), PACKAGE_MAX) {
        Ok(text) => text,
        Err(()) => Some(String::new()),
    }
}

/// What a lane's folder holds for the page to choose a command from ([`Project`]). Only a lane's own folder is read.
pub fn read(home: &Path, cwd: &Path) -> Result<Project, String> {
    if cfg!(not(unix)) {
        return Err("unsupported".into());
    }
    let dir = lane_folder(home, cwd)?;
    let mut files: Vec<String> = fs::read_dir(&dir).map(|rd| rd.flatten().take(NAMES_MAX).map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    files.sort();
    Ok(Project { package_json: package_of(&dir), files, env_example: read_small(&dir.join(".env.example"), ENV_EXAMPLE_MAX).ok().flatten() })
}

// ---------------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------------

/// One stream's bytes as lines: split on a line feed, a carriage return before it taken off, and a line redrawn in place
/// (a progress bar's carriage returns) read as what shows last. A line longer than [`LINE_BYTES`] is cut there and the
/// rest of it dropped, so one huge line costs a bounded look.
#[derive(Default)]
struct Lines {
    pending: Vec<u8>,
    skipping: bool,
}

impl Lines {
    fn push(&mut self, bytes: &[u8], out: &mut Vec<String>) {
        for &b in bytes {
            if b == b'\n' {
                if !self.skipping {
                    out.push(line_text(&self.pending));
                }
                self.pending.clear();
                self.skipping = false;
            } else if !self.skipping {
                self.pending.push(b);
                if self.pending.len() >= LINE_BYTES {
                    out.push(line_text(&self.pending));
                    self.pending.clear();
                    self.skipping = true;
                }
            }
        }
    }

    fn end(&mut self, out: &mut Vec<String>) {
        if !self.pending.is_empty() && !self.skipping {
            out.push(line_text(&self.pending));
        }
        self.pending.clear();
    }
}

fn line_text(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    let text = text.strip_suffix('\r').unwrap_or(&text);
    text.rsplit('\r').next().unwrap_or("").to_string()
}

/// Reads `r` to its end, handing each line to `tx`.
fn read_lines(mut r: impl Read, tx: mpsc::Sender<String>) {
    let mut lines = Lines::default();
    let mut buf = [0u8; 8 * 1024];
    let mut out = Vec::new();
    loop {
        match r.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                lines.push(&buf[..n], &mut out);
                for l in out.drain(..) {
                    if tx.send(l).is_err() {
                        return;
                    }
                }
            }
        }
    }
    lines.end(&mut out);
    for l in out {
        let _ = tx.send(l);
    }
}

// ---------------------------------------------------------------------------------------------
// The running previews
// ---------------------------------------------------------------------------------------------

type Sink = Arc<Mutex<Box<dyn FnMut(PreviewOut) + Send>>>;

struct Live {
    pid: u32,
    /// The lane folder it runs in, as a real path: one preview per folder.
    folder: PathBuf,
    child: Arc<Mutex<Child>>,
    tree: Arc<Option<ProcessTree>>,
    exited: Arc<AtomicBool>,
    /// The shell is ending it (Stop, the session, a reload, the app quitting): its end then says so.
    stopped: Arc<AtomicBool>,
}

/// Every preview this app started that has not ended yet.
#[derive(Default)]
pub struct Previews {
    live: Arc<Mutex<HashMap<u32, Live>>>,
    next: AtomicU32,
    /// Starts one at a time, so two at once never both find the lane's folder free.
    starting: Mutex<()>,
}

impl Previews {
    pub fn new() -> Arc<Previews> {
        Arc::new(Previews::default())
    }

    /// Start a preview of the lane folder `cwd` with `argv`, once the folder's `package.json` is still `package` (the text the
    /// page chose from; `changed` otherwise, and the page reads it again) and no preview runs there (`running`). `secrets` are
    /// the variables set over the few the preview needs ([`preview_env`]). Its lines and its end go to `sink`. The id it
    /// answers names it to [`Previews::stop`] and to what keeps running.
    pub fn start<F>(&self, home: &Path, cwd: &Path, argv: &[String], package: &str, secrets: &[(String, String)], sink: F) -> Result<u32, String>
    where
        F: FnMut(PreviewOut) + Send + 'static,
    {
        if cfg!(not(unix)) {
            return Err("unsupported".into());
        }
        let dir = lane_folder(home, cwd)?;
        let (manager, script) = check_argv(argv)?;
        check_secrets(secrets)?;
        let dirs = crate::sessions::host_dirs();
        let program = crate::accounts::resolve(manager, &dirs, crate::sessions::is_program_file, crate::platform::Os::current()).ok_or_else(|| format!("missing:{manager}"))?;
        let path = child_path(&program, &dirs)?;
        self.start_with(&dir, &program, script, path, package, secrets, sink)
    }

    /// [`Previews::start`] once the folder is checked and the program found: `program run <script>` in `dir`.
    #[allow(clippy::too_many_arguments)]
    fn start_with<F>(&self, dir: &Path, program: &Path, script: &str, path: OsString, package: &str, secrets: &[(String, String)], sink: F) -> Result<u32, String>
    where
        F: FnMut(PreviewOut) + Send + 'static,
    {
        let _turn = self.starting.lock().unwrap_or_else(|e| e.into_inner());
        if package_of(dir).as_deref() != Some(package) {
            return Err("changed".into());
        }
        if self.live.lock().unwrap().values().any(|l| l.folder == dir && !l.exited.load(Ordering::SeqCst)) {
            return Err("running".into());
        }
        let app: Vec<(OsString, OsString)> = std::env::vars_os().collect();
        let mut cmd = Command::new(program);
        cmd.args(["run", script]).current_dir(dir).env_clear().envs(preview_env(&app, path, secrets)).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // its own group, so Stop ends what it started too (the `node` under `pnpm`), as a chat's close does
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().map_err(|e| format!("spawn: {e}"))?;
        let pid = child.id();
        let tree = Arc::new(ProcessTree::adopt(&child));
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let child = Arc::new(Mutex::new(child));
        let exited = Arc::new(AtomicBool::new(false));
        let stopped = Arc::new(AtomicBool::new(false));
        let sink: Sink = Arc::new(Mutex::new(Box::new(sink)));
        // set under the sink's lock once the end is sent: no line goes after it
        let closed = Arc::new(AtomicBool::new(false));
        let output_done = Arc::new(AtomicBool::new(false));
        // listed before anything watches it, so a program that ends at once is still taken off the list when it does
        self.live.lock().unwrap().insert(id, Live { pid, folder: dir.to_path_buf(), child: child.clone(), tree: tree.clone(), exited: exited.clone(), stopped: stopped.clone() });

        let (tx, rx) = mpsc::channel::<String>();
        let tx2 = tx.clone();
        thread::spawn(move || read_lines(stdout, tx));
        thread::spawn(move || read_lines(stderr, tx2));
        {
            let (sink, closed, output_done) = (sink.clone(), closed.clone(), output_done.clone());
            thread::spawn(move || {
                while let Ok(first) = rx.recv() {
                    let mut batch = vec![first];
                    let deadline = Instant::now() + BATCH_EVERY;
                    loop {
                        let left = deadline.saturating_duration_since(Instant::now());
                        if left.is_zero() {
                            break;
                        }
                        match rx.recv_timeout(left) {
                            Ok(l) => batch.push(l),
                            Err(_) => break,
                        }
                    }
                    if batch.len() > BATCH_MAX {
                        batch.drain(..batch.len() - BATCH_MAX);
                    }
                    let mut f = sink.lock().unwrap_or_else(|e| e.into_inner());
                    if !closed.load(Ordering::SeqCst) {
                        f(PreviewOut::Lines(batch));
                    }
                }
                // both pipes reached their end
                output_done.store(true, Ordering::SeqCst);
            });
        }
        {
            let (child, tree, exited, stopped, live) = (child.clone(), tree.clone(), exited.clone(), stopped.clone(), self.live.clone());
            thread::spawn(move || {
                let code = loop {
                    if let Ok(Some(st)) = child.lock().unwrap_or_else(|e| e.into_inner()).try_wait() {
                        break st.code();
                    }
                    thread::sleep(Duration::from_millis(40));
                };
                exited.store(true, Ordering::SeqCst);
                // What it started and left behind goes with it, so nothing of a preview runs on unseen after it ended.
                if let Some(t) = tree.as_ref() {
                    t.kill();
                }
                let deadline = Instant::now() + Duration::from_millis(800);
                while !output_done.load(Ordering::SeqCst) && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(10));
                }
                {
                    let mut f = sink.lock().unwrap_or_else(|e| e.into_inner());
                    closed.store(true, Ordering::SeqCst);
                    f(PreviewOut::Exit { code, stopped: stopped.load(Ordering::SeqCst) });
                }
                live.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            });
        }
        Ok(id)
    }

    /// Stop preview `id` and everything it started: `stopping` once the hang-up is sent (what still runs after the grace is
    /// killed), `gone` when it ended already or there is no such preview. Its end then says it was stopped.
    pub fn stop(&self, id: u32) -> &'static str {
        let found = self.live.lock().unwrap().get(&id).map(|l| (l.pid, l.child.clone(), l.tree.clone(), l.exited.clone(), l.stopped.clone()));
        let Some((pid, child, tree, exited, stopped)) = found else { return "gone" };
        if !hang_up(pid, &child, &stopped) {
            return "gone";
        }
        thread::spawn(move || finish(pid, &child, &tree, &exited, GRACE));
        "stopping"
    }

    /// Whether preview `id` runs as process `pid`: what keeps running names a preview by both, so its Stop reaches only the
    /// preview it listed.
    pub fn is(&self, id: u32, pid: u32) -> bool {
        self.live.lock().unwrap().get(&id).is_some_and(|l| l.pid == pid && !l.exited.load(Ordering::SeqCst))
    }

    /// Stop every preview, and wait until each has ended or been killed: the app quitting, or the page loading again (a
    /// reload keeps the shell alive, and a preview whose page is gone would run on unseen).
    pub fn close_all(&self) {
        let all: Vec<(u32, Arc<Mutex<Child>>, Arc<Option<ProcessTree>>, Arc<AtomicBool>, Arc<AtomicBool>)> =
            self.live.lock().unwrap().values().map(|l| (l.pid, l.child.clone(), l.tree.clone(), l.exited.clone(), l.stopped.clone())).collect();
        let handles: Vec<_> = all
            .into_iter()
            .filter(|(pid, child, _, _, stopped)| hang_up(*pid, child, stopped))
            .map(|(pid, child, tree, exited, _)| thread::spawn(move || finish(pid, &child, &tree, &exited, GRACE_ALL)))
            .collect();
        for h in handles {
            let _ = h.join();
        }
    }

    /// Every preview still running: its id, its program's process id and its folder (what keeps running walks from these).
    pub fn roots(&self) -> Vec<(u32, u32, PathBuf)> {
        self.live.lock().unwrap().iter().filter(|(_, l)| !l.exited.load(Ordering::SeqCst)).map(|(id, l)| (*id, l.pid, l.folder.clone())).collect()
    }

    #[cfg(test)]
    fn count(&self) -> usize {
        self.live.lock().unwrap().len()
    }
}

/// The hang-up to a preview's group, sent while its program is held, so the program cannot end and be reaped (and its
/// number go to another process) between the look and the signal. False when it had ended already.
fn hang_up(pid: u32, child: &Arc<Mutex<Child>>, stopped: &AtomicBool) -> bool {
    let mut c = child.lock().unwrap_or_else(|e| e.into_inner());
    if !matches!(c.try_wait(), Ok(None)) {
        return false;
    }
    stopped.store(true, Ordering::SeqCst);
    signal_group(Some(pid), false);
    true
}

/// After the hang-up: whatever still runs once `grace` has passed is killed, and the group with it.
fn finish(pid: u32, child: &Arc<Mutex<Child>>, tree: &Arc<Option<ProcessTree>>, exited: &AtomicBool, grace: Duration) {
    let deadline = Instant::now() + grace;
    while !exited.load(Ordering::SeqCst) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(25));
    }
    if !exited.load(Ordering::SeqCst) {
        let mut c = child.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(c.try_wait(), Ok(None)) {
            signal_group(Some(pid), true);
            let _ = c.kill();
        }
    }
    if let Some(t) = tree.as_ref() {
        t.kill();
    }
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn os(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect()
    }

    fn pairs(env: &[(OsString, OsString)]) -> Vec<(String, String)> {
        env.iter().map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned())).collect()
    }

    #[test]
    fn only_the_sixteen_commands_the_page_can_choose_are_run() {
        for m in MANAGERS {
            for s in SCRIPTS {
                assert_eq!(check_argv(&words(&[m, "run", s])), Ok((m, s)), "{m} run {s}");
            }
        }
        for bad in [
            &[][..],
            &["pnpm"],
            &["pnpm", "run"],
            &["pnpm", "run", "build"],
            &["pnpm", "run", "deploy"],
            &["pnpm", "exec", "dev"],
            &["pnpm", "dev"],
            &["pnpm", "run", "dev", "--", "--host"],
            &["/opt/homebrew/bin/pnpm", "run", "dev"],
            &["sh", "-c", "pnpm run dev"],
            &["npx", "run", "dev"],
            &["pnpm;rm", "run", "dev"],
            &["Pnpm", "run", "dev"],
            &["pnpm", "RUN", "dev"],
            &["pnpm", "run", "dev "],
        ] {
            assert_eq!(check_argv(&words(bad)), Err("bad_command".to_string()), "{bad:?}");
        }
    }

    #[test]
    fn the_environment_starts_empty_and_takes_only_what_a_dev_server_needs_then_the_samples() {
        let app = os(&[
            ("HOME", "/Users/you"),
            ("USER", "you"),
            ("LOGNAME", "you"),
            ("SHELL", "/bin/zsh"),
            ("TMPDIR", "/var/folders/xy/T/"),
            ("LANG", "th_TH.UTF-8"),
            ("LC_ALL", "th_TH.UTF-8"),
            ("LC_CTYPE", "UTF-8"),
            ("TERM", "xterm-256color"),
            ("PATH", "/somewhere/else"),
            // what the person exported in their shell, and the app's own: none of it reaches a preview
            ("OPENAI_API_KEY", "sk-real-key-from-the-shell"),
            ("AWS_SECRET_ACCESS_KEY", "real"),
            ("PROMPTPAY_SHOP_ID", "0812345678"),
            ("NODE_OPTIONS", "--require /tmp/x.js"),
            ("DYLD_INSERT_LIBRARIES", "/tmp/x.dylib"),
            ("LC_", "not a category"),
            ("lc_all", "not one either"),
            ("MANUT_RUNTIME", "connected"),
        ]);
        let secrets = vec![("PROMPTPAY_SHOP_ID".to_string(), "0000000000".to_string()), ("STRIPE_SECRET_KEY".to_string(), "sample-stripe_secret_key".to_string())];
        assert_eq!(check_secrets(&secrets), Ok(()));
        let env = pairs(&preview_env(&app, "/opt/homebrew/bin:/usr/bin:/bin".into(), &secrets));
        let want: Vec<(String, String)> = [
            ("HOME", "/Users/you"),
            ("LANG", "th_TH.UTF-8"),
            ("LC_ALL", "th_TH.UTF-8"),
            ("LC_CTYPE", "UTF-8"),
            ("LOGNAME", "you"),
            ("PATH", "/opt/homebrew/bin:/usr/bin:/bin"),
            // the sample, set explicitly over the real one the app's environment had, so a .env file does not win either
            ("PROMPTPAY_SHOP_ID", "0000000000"),
            ("SHELL", "/bin/zsh"),
            ("STRIPE_SECRET_KEY", "sample-stripe_secret_key"),
            ("TERM", "dumb"),
            ("TMPDIR", "/var/folders/xy/T/"),
            ("USER", "you"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        assert_eq!(env, want);
    }

    #[test]
    fn an_app_with_no_lang_gives_the_preview_the_one_a_chat_gets_and_no_secret_means_none_set() {
        let env = pairs(&preview_env(&os(&[("HOME", "/Users/you")]), "/usr/bin".into(), &[]));
        assert_eq!(env, [("HOME", "/Users/you"), ("LANG", "en_US.UTF-8"), ("PATH", "/usr/bin"), ("TERM", "dumb")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>());
    }

    #[test]
    fn a_secret_cannot_take_the_name_of_what_the_preview_runs_with_nor_be_malformed() {
        let one = |n: &str, v: &str| check_secrets(&[(n.to_string(), v.to_string())]);
        for ok in ["API_KEY", "_TOKEN", "promptpay_shop_id", "A", "STRIPE_SECRET_KEY_2"] {
            assert_eq!(one(ok, "sample-value"), Ok(()), "{ok}");
        }
        for name in ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM", "LC_ALL", "LC_CTYPE", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "", "1KEY", "API-KEY", "A KEY", "KEY=1", "ÄPI_KEY"] {
            assert_eq!(one(name, "x"), Err("bad_env".to_string()), "{name:?}");
        }
        assert_eq!(one(&"K".repeat(SECRET_NAME_MAX + 1), "x"), Err("bad_env".to_string()));
        assert_eq!(one("API_KEY", "a\0b"), Err("bad_env".to_string()));
        assert_eq!(one("API_KEY", &"v".repeat(SECRET_VALUE_MAX + 1)), Err("bad_env".to_string()));
        let many: Vec<(String, String)> = (0..=SECRETS_MAX).map(|i| (format!("KEY_{i}"), "v".to_string())).collect();
        assert_eq!(check_secrets(&many), Err("bad_env".to_string()));
    }

    /// The page's own table (src/code/previewFrame.test.ts runs it against `loopbackUrl`), so the shell's rule and the page's
    /// are one rule: the address Open hands the browser is the address the frame may show.
    fn loopback_table() -> (Vec<String>, Vec<String>) {
        let table: serde_json::Value = serde_json::from_str(include_str!("../../src/code/__fixtures__/loopback.json")).unwrap();
        let list = |key: &str| table[key].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect::<Vec<_>>();
        (list("ok"), list("bad"))
    }

    #[test]
    fn open_takes_only_an_address_of_this_computer_as_the_dev_url_reader_shows_one() {
        let (ok, bad) = loopback_table();
        assert!(ok.len() > 10 && bad.len() > 40);
        for url in &ok {
            assert!(loopback_url(url), "{url}");
        }
        for url in &bad {
            assert!(!loopback_url(url), "{url:?}");
        }
    }

    #[test]
    fn the_app_window_loads_its_own_pages_empty_frames_and_this_computers_addresses_and_nothing_else() {
        for url in [
            // the app's own page, as each system serves it, and its pages under it
            "tauri://localhost",
            "tauri://localhost/",
            "tauri://localhost/index.html?x=1#y",
            "http://tauri.localhost/",
            "https://tauri.localhost/settings",
            // a debug build's dev server
            "http://localhost:5207/",
            // the frame beside a lane, and a dev server's own pages in it
            "http://localhost:5173/",
            "http://localhost:5173/checkout?step=2#pay",
            "https://localhost:3000/@vite/client",
            "http://127.0.0.1:8080/admin",
            "http://[::1]:5173/about",
            "about:blank",
            "about:srcdoc",
            "about:blank#top",
        ] {
            assert!(app_window_may_load(url), "{url}");
        }
        for url in [
            "https://example.com/",
            "http://192.168.110.34:5382/other.html",
            "http://localhost.evil.example:5173/",
            "http://localhost:5173@evil.example/",
            "http://you@localhost:5173/",
            "http://0.0.0.0:5173/",
            "http://127.0.0.2:5173/",
            "http://localhost:0/",
            "http://localhost:65536/",
            "tauri://localhost.evil.example/",
            "tauri://localhost@evil.example/",
            "tauri://evil.example/",
            "http://tauri.localhost.evil.example/",
            "https://tauri.localhost:8443/",
            "ipc://localhost/preview_open",
            "asset://localhost/etc/passwd",
            "about:config",
            "data:text/html,<p>hi</p>",
            "blob:tauri://localhost/0f0f",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "manut://terminal/1",
            "ws://localhost:5173/",
            "",
        ] {
            assert!(!app_window_may_load(url), "{url}");
        }
        // every address Open takes, the window may show; any path on one is the dev server's own page
        let (ok, _) = loopback_table();
        for url in &ok {
            assert!(app_window_may_load(url), "{url}");
            assert!(app_window_may_load(&format!("{url}page?q=1")), "{url}page");
        }
    }

    #[test]
    fn lines_are_split_cut_and_read_as_what_shows_last() {
        let mut l = Lines::default();
        let mut out = Vec::new();
        l.push(b"  VITE v7.1.2  ready\r\n  \x1b[32m\xe2\x9e\x9c\x1b[39m  Local:   http://localhost:", &mut out);
        l.push(b"5173/\nbuilding 10%\rbuilding 90%\rbuilt\nhalf a line", &mut out);
        l.end(&mut out);
        assert_eq!(out, ["  VITE v7.1.2  ready", "  \x1b[32m\u{279c}\x1b[39m  Local:   http://localhost:5173/", "built", "half a line"]);

        let mut l = Lines::default();
        let mut out = Vec::new();
        let long = vec![b'x'; LINE_BYTES * 3];
        l.push(&long, &mut out);
        l.push(b"\nnext\n", &mut out);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].len(), LINE_BYTES);
        assert_eq!(out[1], "next");
    }

    // ---- folders --------------------------------------------------------------------------------------------------

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("manut-preview-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    /// A home with a lane's folder in it (`~/.manut/lanes/web-app/promptpay-qr`) and the developer's own folder beside it.
    fn home_with_lane(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let home = tmp(name);
        let lane = home.join(".manut").join("lanes").join("web-app").join("promptpay-qr");
        fs::create_dir_all(lane.join("apps").join("web")).unwrap();
        let own = home.join("code").join("web-app");
        fs::create_dir_all(&own).unwrap();
        (home, lane, own)
    }

    #[test]
    fn only_a_lanes_own_folder_or_one_inside_it_is_a_place_for_a_preview() {
        let (home, lane, own) = home_with_lane("folders");
        assert_eq!(lane_folder(&home, &lane), Ok(lane.clone()));
        assert_eq!(lane_folder(&home, &lane.join("apps/web")), Ok(lane.join("apps/web")));
        let refused = Err("not_a_lane".to_string());
        // the developer's own folder, the lanes' folder itself and a project's folder of lanes, a relative path, a file
        assert_eq!(lane_folder(&home, &own), refused);
        assert_eq!(lane_folder(&home, &home.join(".manut/lanes")), refused);
        assert_eq!(lane_folder(&home, &home.join(".manut/lanes/web-app")), refused);
        assert_eq!(lane_folder(&home, Path::new("web-app/promptpay-qr")), refused);
        assert_eq!(lane_folder(&home, &lane.join("..").join("..").join("..").join("..").join("code").join("web-app")), refused);
        fs::write(lane.join("package.json"), "{}").unwrap();
        assert_eq!(lane_folder(&home, &lane.join("package.json")), refused);
        assert_eq!(lane_folder(&home, &home.join(".manut/lanes/web-app/gone")), refused);
        // a link in the lanes' folder that points at the developer's folder is the developer's folder
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&own, home.join(".manut/lanes/web-app/linked")).unwrap();
            assert_eq!(lane_folder(&home, &home.join(".manut/lanes/web-app/linked")), refused);
        }
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    #[cfg(unix)]
    fn reading_a_lane_gives_its_package_json_its_root_names_and_its_env_example_and_never_follows_a_link() {
        let (home, lane, own) = home_with_lane("read");
        assert_eq!(read(&home, &own), Err("not_a_lane".to_string()));
        assert_eq!(read(&home, &lane), Ok(Project { package_json: None, files: vec!["apps".into()], env_example: None }));
        fs::write(lane.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        fs::write(lane.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n").unwrap();
        fs::write(lane.join(".env.example"), "STRIPE_SECRET_KEY=\n").unwrap();
        assert_eq!(
            read(&home, &lane),
            Ok(Project {
                package_json: Some(r#"{"scripts":{"dev":"vite"}}"#.into()),
                files: vec![".env.example".into(), "apps".into(), "package.json".into(), "pnpm-lock.yaml".into()],
                env_example: Some("STRIPE_SECRET_KEY=\n".into()),
            })
        );
        // a link where package.json or .env.example would be is not read: package.json is then unreadable, the example none
        let secret = own.join("id_rsa");
        fs::write(&secret, "PRIVATE").unwrap();
        fs::remove_file(lane.join("package.json")).unwrap();
        fs::remove_file(lane.join(".env.example")).unwrap();
        std::os::unix::fs::symlink(&secret, lane.join("package.json")).unwrap();
        std::os::unix::fs::symlink(&secret, lane.join(".env.example")).unwrap();
        let p = read(&home, &lane).unwrap();
        assert_eq!(p.package_json, Some(String::new()));
        assert_eq!(p.env_example, None);
        // too big to read is unreadable too
        fs::remove_file(lane.join("package.json")).unwrap();
        fs::write(lane.join("package.json"), vec![b' '; PACKAGE_MAX as usize + 1]).unwrap();
        assert_eq!(read(&home, &lane).unwrap().package_json, Some(String::new()));
        let _ = fs::remove_dir_all(&home);
    }

    // ---- real runs ------------------------------------------------------------------------------------------------

    /// What a preview's sink got, and a way to wait for it.
    #[derive(Clone, Default)]
    struct Got(Arc<Mutex<Vec<PreviewOut>>>);

    impl Got {
        fn sink(&self) -> impl FnMut(PreviewOut) + Send + 'static {
            let got = self.0.clone();
            move |o| got.lock().unwrap().push(o)
        }
        fn lines(&self) -> Vec<String> {
            self.0.lock().unwrap().iter().flat_map(|o| if let PreviewOut::Lines(l) = o { l.clone() } else { vec![] }).collect()
        }
        fn exit(&self) -> Option<PreviewOut> {
            self.0.lock().unwrap().iter().find(|o| matches!(o, PreviewOut::Exit { .. })).cloned()
        }
        fn wait(&self, what: &str, until: impl Fn(&Got) -> bool) {
            let deadline = Instant::now() + Duration::from_secs(20);
            while !until(self) {
                assert!(Instant::now() < deadline, "waited for {what}: {:?}", self.0.lock().unwrap());
                thread::sleep(Duration::from_millis(20));
            }
        }
    }

    /// A stand-in for a package manager in the lane: a shell script that does what `script` says, given its own name and the
    /// words `run <script>`.
    #[cfg(unix)]
    fn manager(home: &Path, script: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let bin = home.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let p = bin.join("pnpm");
        fs::write(&p, format!("#!/bin/sh\n{script}\n")).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[cfg(unix)]
    fn alive(pid: u32) -> bool {
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }

    const PACKAGE: &str = r#"{"scripts":{"dev":"vite"}}"#;

    #[test]
    #[cfg(unix)]
    fn a_preview_runs_in_its_lane_with_its_own_words_and_environment_and_stop_ends_its_whole_group() {
        let (home, lane, _) = home_with_lane("run");
        fs::write(lane.join("package.json"), PACKAGE).unwrap();
        // it says where it is and what it was given, then starts a helper of its own (a dev server's `node` under `pnpm`)
        let program = manager(&home, "echo \"args $*\"\necho \"cwd $(pwd -P)\"\n/usr/bin/env | /usr/bin/sort\n/bin/sleep 300 &\necho \"helper $!\"\necho \"  Local:   http://localhost:5173/\"\nwait");
        let previews = Previews::default();
        let got = Got::default();
        let secrets = vec![("PROMPTPAY_SHOP_ID".to_string(), "0000000000".to_string())];
        let id = previews.start_with(&lane, &program, "dev", format!("{}:/usr/bin:/bin", program.parent().unwrap().display()).into(), PACKAGE, &secrets, got.sink()).unwrap();
        got.wait("its address", |g| g.lines().iter().any(|l| l.contains("http://localhost:5173/")));
        let lines = got.lines();
        assert!(lines.contains(&"args run dev".to_string()), "{lines:?}");
        assert!(lines.contains(&format!("cwd {}", lane.display())), "{lines:?}");
        // the environment it got: what a dev server needs, and the sample over everything else
        let env: Vec<&String> = lines.iter().filter(|l| l.contains('=') && !l.starts_with(' ')).collect();
        let names: Vec<&str> = env.iter().map(|l| l.split('=').next().unwrap()).collect();
        assert!(lines.contains(&"PROMPTPAY_SHOP_ID=0000000000".to_string()), "{lines:?}");
        assert!(lines.contains(&"TERM=dumb".to_string()), "{lines:?}");
        assert!(names.contains(&"PATH") && names.contains(&"LANG"), "{names:?}");
        for name in &names {
            assert!(PASSED.contains(name) || is_locale(name) || ["PATH", "TERM", "PROMPTPAY_SHOP_ID", "PWD", "SHLVL", "OLDPWD", "_"].contains(name), "{name} reached the preview: {lines:?}");
        }
        // cargo's own variables are in this test's environment and must not be in the preview's
        assert!(std::env::var_os("CARGO_PKG_NAME").is_some());
        assert!(!names.iter().any(|n| n.starts_with("CARGO") || n.starts_with("RUST")), "{names:?}");

        let helper: u32 = lines.iter().find_map(|l| l.strip_prefix("helper ")).unwrap().trim().parse().unwrap();
        let roots = previews.roots();
        assert_eq!(roots.len(), 1);
        let (rid, pid, folder) = roots[0].clone();
        assert_eq!((rid, folder), (id, lane.clone()));
        assert!(previews.is(id, pid) && !previews.is(id, pid + 1) && !previews.is(id + 1, pid));
        assert!(alive(pid) && alive(helper));

        assert_eq!(previews.stop(id), "stopping");
        got.wait("its end", |g| g.exit().is_some());
        assert!(matches!(got.exit(), Some(PreviewOut::Exit { stopped: true, .. })), "{:?}", got.exit());
        let deadline = Instant::now() + Duration::from_secs(5);
        while (alive(helper) || alive(pid)) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(!alive(helper), "the helper it started outlived Stop");
        assert!(previews.roots().is_empty());
        assert_eq!(previews.stop(id), "gone");
        // nothing after its end
        let n = got.0.lock().unwrap().len();
        thread::sleep(Duration::from_millis(150));
        assert_eq!(got.0.lock().unwrap().len(), n);
        let deadline = Instant::now() + Duration::from_secs(2);
        while previews.count() > 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(previews.count(), 0);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    #[cfg(unix)]
    fn a_preview_that_ends_by_itself_says_its_code_and_was_not_stopped() {
        let (home, lane, _) = home_with_lane("ends");
        fs::write(lane.join("package.json"), PACKAGE).unwrap();
        let program = manager(&home, "echo 'Error: Cannot find module vite' >&2\nexit 3");
        let previews = Previews::default();
        let got = Got::default();
        previews.start_with(&lane, &program, "dev", "/usr/bin:/bin".into(), PACKAGE, &[], got.sink()).unwrap();
        got.wait("its end", |g| g.exit().is_some());
        assert_eq!(got.exit(), Some(PreviewOut::Exit { code: Some(3), stopped: false }));
        assert_eq!(got.lines(), ["Error: Cannot find module vite"]);
        assert!(previews.roots().is_empty());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    #[cfg(unix)]
    fn a_preview_starts_only_from_the_package_json_the_page_read_and_once_per_lane() {
        let (home, lane, _) = home_with_lane("once");
        fs::write(lane.join("package.json"), PACKAGE).unwrap();
        let program = manager(&home, "/bin/sleep 300");
        let previews = Previews::default();
        // Kit changed the scripts after the page read them: the page must read them again
        let edited = r#"{"scripts":{"dev":"vite","predev":"vercel deploy --prod"}}"#;
        fs::write(lane.join("package.json"), edited).unwrap();
        assert_eq!(previews.start_with(&lane, &program, "dev", "/usr/bin:/bin".into(), PACKAGE, &[], |_| {}), Err("changed".to_string()));
        assert_eq!(previews.count(), 0);
        fs::write(lane.join("package.json"), PACKAGE).unwrap();
        let first = Got::default();
        let id = previews.start_with(&lane, &program, "dev", "/usr/bin:/bin".into(), PACKAGE, &[], first.sink()).unwrap();
        // one preview per lane: a second start there is refused while the first runs, wherever in the lane it is asked
        assert_eq!(previews.start_with(&lane, &program, "dev", "/usr/bin:/bin".into(), PACKAGE, &[], |_| {}), Err("running".to_string()));
        previews.close_all();
        first.wait("its end", |g| g.exit().is_some());
        assert!(matches!(first.exit(), Some(PreviewOut::Exit { stopped: true, .. })));
        assert!(previews.roots().is_empty());
        // and again, once it has ended
        let again = Got::default();
        let id2 = previews.start_with(&lane, &program, "dev", "/usr/bin:/bin".into(), PACKAGE, &[], again.sink()).unwrap();
        assert_ne!(id, id2);
        assert_eq!(previews.stop(id2), "stopping");
        again.wait("its end", |g| g.exit().is_some());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    #[cfg(unix)]
    fn start_refuses_a_folder_that_is_not_a_lane_a_command_it_cannot_run_and_a_bad_secret_before_anything_runs() {
        let (home, lane, own) = home_with_lane("refuse");
        fs::write(own.join("package.json"), PACKAGE).unwrap();
        fs::write(lane.join("package.json"), PACKAGE).unwrap();
        let previews = Previews::default();
        let dev = words(&["pnpm", "run", "dev"]);
        assert_eq!(previews.start(&home, &own, &dev, PACKAGE, &[], |_| {}), Err("not_a_lane".to_string()));
        assert_eq!(previews.start(&home, &lane, &words(&["pnpm", "run", "build"]), PACKAGE, &[], |_| {}), Err("bad_command".to_string()));
        assert_eq!(previews.start(&home, &lane, &dev, PACKAGE, &[("PATH".into(), "/tmp".into())], |_| {}), Err("bad_env".to_string()));
        assert_eq!(previews.count(), 0);
        let _ = fs::remove_dir_all(&home);
    }
}
