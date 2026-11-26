//! Live chat processes: [`ChatSessions`] starts the allow-listed agent on pipes, feeds its lines to the adapter
//! for that agent, writes the adapter's replies back, hands the events to the page in coalesced batches, and
//! stops the whole process group when a session is closed or the app quits. It knows nothing of any one agent's
//! protocol: that stays behind [`Adapter`].

use super::*;
use super::subagents::{START_DEADLINE, exit_turn_end, exit_why, no_chat_mode, protocol_lines, refused_chat_mode};
use super::codex::Codex;

// ---------------------------------------------------------------------------------------------
// Live chat processes
// ---------------------------------------------------------------------------------------------

/// What a chat session sends back: events, then once, the exit (code; `None` after a signal) with the last
/// lines the program wrote to stderr.
#[derive(Debug, Clone, PartialEq)]
pub enum ChatOut {
    Event(Event),
    Exit(Option<i32>, String),
}

type ChatSink = Arc<Mutex<Box<dyn FnMut(ChatOut) + Send>>>;

/// Input for a chat's writer thread, which owns the program's stdin. `None` once the session is stopping:
/// dropping the last sender ends the writer thread, which closes stdin (the agents' orderly shutdown).
type ChatInputQueue = Arc<Mutex<Option<SyncSender<Vec<u8>>>>>;

struct ChatLive {
    stdin: ChatInputQueue,
    adapter: Arc<Mutex<Box<dyn Adapter>>>,
    sink: ChatSink,
    child: Arc<Mutex<Child>>,
    pid: u32,
    /// the program and everything it started (`cmd.exe` and its `node.exe` on Windows)
    tree: Arc<Option<ProcessTree>>,
    exited: Arc<AtomicBool>,
    /// the folder it started in (what keeps running names its commands by it: [`ChatSessions::roots`])
    cwd: PathBuf,
}

/// Every running chat session of this app. [`ChatSessions::close_all`] runs on exit.
#[derive(Default)]
pub struct ChatSessions {
    live: Mutex<HashMap<u32, ChatLive>>,
    /// DSH chats: no process between messages, a run per message ([`DshChat`])
    dsh: Mutex<HashMap<u32, DshChat>>,
    next: AtomicU32,
    /// tests: a shorter [`START_DEADLINE`]
    start_deadline: Option<Duration>,
    /// tests: the home whose `~/.manut/project-notes` holds a chat's instructions file ([`ChatSessions::notes_home`])
    notes_home: Option<PathBuf>,
}

/// Queue `lines` for the chat's writer thread. Never blocks (a pipe takes only so much before a write
/// would): an agent that stops reading its input makes this fail once the queue is full.
fn write_lines(stdin: &ChatInputQueue, lines: &[String]) -> Result<(), String> {
    if lines.is_empty() {
        return Ok(());
    }
    let mut chunk = Vec::new();
    for l in lines {
        chunk.extend_from_slice(l.as_bytes());
        chunk.push(b'\n');
    }
    let tx = stdin.lock().unwrap().clone().ok_or("the session has ended")?;
    match tx.try_send(chunk) {
        Ok(()) => Ok(()),
        Err(TrySendError::Full(_)) => Err("the agent is not reading its input".into()),
        Err(TrySendError::Disconnected(_)) => Err("the session has ended".into()),
    }
}

/// Adjacent `delta` events of one read window become one, so a fast token stream is a few UI messages.
fn merge_deltas(events: Vec<Event>) -> Vec<Event> {
    // streamed answer text, and streamed thinking text, each joined with the piece right before it of its own kind
    let joinable = |e: &Event| e.as_object().is_some_and(|m| m.len() == 2 && matches!(s(e, "event").as_str(), "delta" | "thinking") && m.get("text").is_some_and(Value::is_string));
    let mut out: Vec<Event> = Vec::with_capacity(events.len());
    for e in events {
        if let Some(last) = out.last_mut() {
            if joinable(last) && joinable(&e) && s(last, "event") == s(&e, "event") {
                let joined = s(last, "text") + &s(&e, "text");
                last["text"] = Value::String(joined);
                continue;
            }
        }
        out.push(e);
    }
    out
}

fn deliver(sink: &ChatSink, events: Vec<Event>) {
    if events.is_empty() {
        return;
    }
    if let Ok(mut f) = sink.lock() {
        for e in events {
            f(ChatOut::Event(e));
        }
    }
}

/// The command a chat runs: `argv` in `cwd` on pipes, with the child `PATH` and the chosen account's home
/// variable (`account_env`, empty for the CLI's own login), the same env a terminal session gets. Nothing
/// else is added.
pub(crate) fn command_for(argv: &[OsString], cwd: &Path, path_env: Option<OsString>, account_env: &[(String, String)]) -> Result<Command, String> {
    let (prog, rest) = argv.split_first().ok_or("empty argv")?;
    let mut cmd = Command::new(prog);
    cmd.args(rest).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(p) = path_env {
        cmd.env("PATH", p);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // its own group, so close stops helpers it started too
        if std::env::var_os("LANG").is_none() {
            cmd.env("LANG", "en_US.UTF-8");
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    for (k, v) in account_env {
        cmd.env(k, v);
    }
    crate::appimage::host_env(&mut cmd);
    Ok(cmd)
}

/// `--add-dir <dir>` with `dir` as one argument. A Windows `.cmd` shim runs through `cmd.exe /c`, which parses the
/// line itself: there the folder goes in as [`cmd_path_arg`] allows it, and a folder it refuses adds nothing (the
/// person then answers a card per read, as before).
fn add_dir_args(program: &OsString, dir: &Path) -> Vec<OsString> {
    let dir = dir.as_os_str().to_owned();
    if program == "cmd.exe" {
        return match cmd_path_arg(&dir.to_string_lossy()) {
            Ok(d) => vec!["--add-dir".into(), d.into()],
            Err(_) => vec![],
        };
    }
    vec!["--add-dir".into(), dir]
}

/// How long an agent's rule listing ([`RuleProbe`]) may take before the chat is refused.
const RULES_DEADLINE: Duration = Duration::from_secs(30);

/// `probe`'s variable and value for a chat of the program `argv` in `cwd`: the program's fixed rule listings run on
/// pipes with no input, with the same `PATH` and account variable the chat gets, and [`crate::acp_chat::probe_rules`]
/// reads them (the first form whose output it can read, listed again with the value set, kept). Any doubt (the variable
/// already set in manut's own environment, failed or slow listings, output it cannot read, rules that did not hold) is
/// [`no_rules`] (with the agent's name, `label`), and the chat does not start.
///
/// `notes`: the project's instructions file for OpenCode (item 93, [`crate::project_notes`]). It joins the value as an
/// `instructions` entry before the second listing, so the rules are checked as OpenCode will get them, with that entry.
#[allow(clippy::too_many_arguments)]
fn agent_rules(probe: &RuleProbe, label: &str, argv: &[OsString], cwd: &Path, path_env: &OsString, account_env: &[(String, String)], notes: Option<&Path>) -> Result<(String, String), String> {
    if !cwd.is_absolute() || !cwd.is_dir() {
        return Err(format!("not a folder: {}", cwd.display()));
    }
    if std::env::var_os(probe.var).is_some() {
        return Err(no_rules(label));
    }
    let list = |args: &[&str], env: &[(String, String)]| -> Option<String> {
        let mut argv = argv.to_vec();
        argv.extend(args.iter().map(OsString::from));
        let mut cmd = command_for(&argv, cwd, Some(path_env.clone()), env).ok()?;
        cmd.stdin(Stdio::null());
        let child = cmd.spawn().ok()?;
        let tree = ProcessTree::adopt(&child);
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let _ = tx.send(child.wait_with_output());
        });
        match rx.recv_timeout(RULES_DEADLINE) {
            Ok(Ok(o)) if o.status.success() => Some(String::from_utf8_lossy(&o.stdout).into_owned()),
            Err(_) => {
                if let Some(t) = tree {
                    t.kill();
                }
                None
            }
            _ => None,
        }
    };
    crate::acp_chat::probe_rules(probe, account_env, &list, notes).ok_or_else(|| no_rules(label))
}

/// Computer use for a chat of Claude Code that is starting (`on`): when the hub runs and macOS has given the app
/// Accessibility (`computer::hub::attach`), its MCP server and skill are added to the command line, its asks go through
/// computer use's adapter (`computer::tap`), and its room goes when the chat ends. Otherwise all three come back as they
/// were. The chat's token comes back too, for [`ChatSessions::bind_computer`] once the process has started.
fn with_computer<F>(on: bool, mut argv: Vec<OsString>, adapter: Box<dyn Adapter>, mut sink: F) -> (Vec<OsString>, Box<dyn Adapter>, impl FnMut(ChatOut) + Send + 'static, Option<String>)
where
    F: FnMut(ChatOut) + Send + 'static,
{
    let attached = if on { crate::computer::hub::attach() } else { None };
    let (adapter, token) = match attached {
        Some(a) => {
            argv.extend(a.args);
            (crate::computer::tap::Tap::wrap(adapter, a.room), Some(a.token))
        }
        None => (adapter, None),
    };
    let ended = token.clone();
    let sink = move |out: ChatOut| {
        if let (ChatOut::Exit(..), Some(t)) = (&out, &ended) {
            crate::computer::hub::detach(t);
        }
        sink(out)
    };
    (argv, adapter, sink, token)
}

/// The arguments the setting "Suggested next message" adds to agent `agent_id`'s chat: Claude Code's `--prompt-suggestions true` when
/// `suggest`, nothing otherwise and nothing for any other agent (none of them has a way to ask for one).
pub fn suggest_args(agent_id: &str, suggest: bool) -> &'static [&'static str] {
    if suggest && agent_id == "claude" {
        &crate::sessions::CLAUDE_SUGGEST_ARGS
    } else {
        &[]
    }
}

impl ChatSessions {
    pub fn new() -> Arc<ChatSessions> {
        Arc::new(ChatSessions::default())
    }

    /// Start allow-listed agent `agent_id` in its chat mode in `cwd`. `resume` (Claude Code, Codex, OmO)
    /// continues that conversation. `account_env` is `accounts::session_env` for that agent, as for a terminal session:
    /// the chosen account's home variable, or nothing. Anything not on the allow-list, or without a chat
    /// mode, is refused before a process exists.
    pub fn start_agent<F>(&self, agent_id: &str, cwd: &Path, resume: Option<&str>, account_env: &[(String, String)], files: Option<&Path>, sink: F) -> Result<u32, String>
    where
        F: FnMut(ChatOut) + Send + 'static,
    {
        self.start_agent_with(agent_id, cwd, resume, account_env, files, false, None, sink)
    }

    /// [`ChatSessions::start_agent`], and `suggest`: the person turned on suggested next messages (item 76), so a Claude Code chat is
    /// started with [`CLAUDE_SUGGEST_ARGS`] and sends a `suggestion` event after each turn. No other agent has a way to ask for one
    /// (Codex's app-server protocol has none), so `suggest` changes nothing for them. `mode` is the permission mode the chat
    /// starts in ([`start_mode`]).
    #[allow(clippy::too_many_arguments)]
    pub fn start_agent_with<F>(&self, agent_id: &str, cwd: &Path, resume: Option<&str>, account_env: &[(String, String)], files: Option<&Path>, suggest: bool, mode: Option<&str>, sink: F) -> Result<u32, String>
    where
        F: FnMut(ChatOut) + Send + 'static,
    {
        let mine = crate::providers::stored_here(agent_id);
        self.start_agent_mine_in(agent_id, cwd, resume, account_env, files, suggest, mode, &mine, sink)
    }

    /// [`ChatSessions::start_agent_mine_in`] in the agent's careful mode (the tests' way in).
    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn start_agent_mine<F>(
        &self,
        agent_id: &str,
        cwd: &Path,
        resume: Option<&str>,
        account_env: &[(String, String)],
        files: Option<&Path>,
        suggest: bool,
        mine: &crate::providers::Stored,
        sink: F,
    ) -> Result<u32, String>
    where
        F: FnMut(ChatOut) + Send + 'static,
    {
        self.start_agent_mine_in(agent_id, cwd, resume, account_env, files, suggest, None, mine, sink)
    }

    /// [`ChatSessions::start_agent_with`] with the agent's Settings › Providers settings `mine`, read once for the whole
    /// start: turned off, nothing starts (not even a person's own agent); its home and variables come before the app's own
    /// variables (the ask rules OpenCode gets win), and its arguments go after every argument added here.
    ///
    /// What the chat's project folder holds never decides what its agent may do (item 89): Claude Code reads the person's
    /// own settings alone ([`crate::sessions::CLAUDE_CHAT_ARGS`]) and starts with `--permission-mode` named here, Codex's
    /// thread starts in the mode named here, and OpenCode reads no project configuration ([`project_config_off`]).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn start_agent_mine_in<F>(
        &self,
        agent_id: &str,
        cwd: &Path,
        resume: Option<&str>,
        account_env: &[(String, String)],
        files: Option<&Path>,
        suggest: bool,
        mode: Option<&str>,
        mine: &crate::providers::Stored,
        sink: F,
    ) -> Result<u32, String>
    where
        F: FnMut(ChatOut) + Send + 'static,
    {
        // the mode the chat starts in, refused before anything is looked up when the agent does not offer it
        let mode = start_mode(agent_id, mode)?;
        // an agent the person added on Settings › Agents and confirmed on its card: read and checked again now
        if agent(agent_id).is_none() {
            if let Some(c) = crate::custom_agents::lookup(agent_id) {
                crate::providers::may_start(&c.label, mine)?;
                return self.start_custom(&c, &crate::sessions::host_dirs(), cwd, resume, account_env, sink);
            }
        }
        let a = agent(agent_id).ok_or_else(|| format!("unknown agent \"{agent_id}\""))?;
        crate::providers::may_start(a.label, mine)?;
        if a.mode != Mode::Chat {
            return Err(format!("{} has no chat mode", a.label));
        }
        if agent_id == "dsh" {
            // DeepSeek Harness: `resume` is the `session-<uuid>` it reported (resume_args checks it); its program is the
            // path set on Settings › Providers when there is one (it takes nothing else from there)
            let chat = DshChat::start(cwd, resume, mine, sink)?;
            let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
            self.dsh.lock().unwrap().insert(id, chat);
            return Ok(id);
        }
        let args = chat_args(agent_id).ok_or("no chat mode")?;
        // Codex continues a thread over its own protocol (`thread/resume`), not by an argument; the id must
        // still be one Codex reported (a UUID). Claude Code takes `--resume <uuid>` ([`resume_args`]).
        // An ACP agent (`acp_chat`) continues over its protocol too (`session/resume`), with an id it reported.
        let acp = acp_agent(agent_id);
        let thread = match (agent_id, resume) {
            ("codex", Some(r)) if is_uuid(r) => Some(r),
            ("codex", Some(_)) => return Err("not a Codex thread id".into()),
            (_, Some(r)) if acp.is_some() && is_acp_session_id(r) => Some(r),
            (_, Some(_)) if acp.is_some() => return Err("not a conversation id".into()),
            _ => None,
        };
        // an ACP agent is handed the project's MCP servers the person approved (acp_mcp.rs); its own it reads itself
        let mut adapter = match (acp, mode) {
            (Some(row), _) => Box::new(Acp::new(row, &cwd.to_string_lossy(), thread).with_mcp(crate::acp_mcp::for_session(cwd))) as Box<dyn Adapter>,
            // Codex's thread starts in the chat's mode, and every turn carries it
            (None, Some(m)) if agent_id == "codex" => Box::new(Codex::new(&cwd.to_string_lossy(), thread).starting_in(m)) as Box<dyn Adapter>,
            _ => adapter_for(agent_id, &cwd.to_string_lossy(), thread).ok_or("no chat adapter")?,
        };
        let (mut argv, path_env) = crate::sessions::launch_with(agent_id, mine)?;
        let through_cmd = argv.first().is_some_and(|p| p == "cmd.exe");
        let program = argv.clone();
        if let Some(path) = unrecognized_program(agent_id) {
            adapter = Unrecognized::wrap(adapter, agent_id, &path);
        }
        if agent_id == "claude" {
            let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).filter(|h| !h.is_empty());
            if let (Some(home), Some(account)) = (home, crate::claude_usage::account_of(account_env)) {
                adapter = UsageTap::wrap(adapter, PathBuf::from(home), account);
            }
        }
        argv.extend(args.iter().map(OsString::from));
        // Claude Code starts in the chat's mode, named on its command line, so no `defaultMode` anywhere chooses it
        if let Some(m) = mode.filter(|_| agent_id == "claude") {
            argv.extend(["--permission-mode".into(), OsString::from(m)]);
        }
        argv.extend(suggest_args(agent_id, suggest).iter().map(OsString::from));
        if let Some(r) = resume.filter(|_| thread.is_none()) {
            argv.extend(resume_args(agent_id, r)?);
        }
        // Claude Code reads the files the person attached without a card: the session's own attachment folder
        // (`session_files::session_dir`, made before the start; a folder made later is not honoured) is its one
        // extra working directory, as one argument. Reads anywhere else outside `cwd` still ask.
        if let Some(dir) = files.filter(|_| agent_id == "claude") {
            argv.extend(add_dir_args(&argv[0], dir));
        }
        // the person's own arguments (Settings › Providers): checked here, and added last of all below
        let extra = crate::providers::extra_args(agent_id, mine, through_cmd)?;
        // The project's own instructions (item 93, crate::project_notes): the switches that keep a project's files from
        // acting also keep Claude Code and OpenCode from reading them, so the app reads them as plain text and hands them
        // over as text appended to the system prompt, in a file of its own that goes when the chat ends (or now, when the
        // start is refused below). A path the start cannot carry is not handed over, and the chat's note says so.
        let mut notes = match crate::project_notes::Agent::of(agent_id) {
            Some(a) => crate::project_notes::prepare(a, cwd, self.notes_home().as_deref()),
            None => crate::project_notes::Prepared::default(),
        };
        if let Some(f) = notes.file().filter(|_| agent_id == "claude") {
            // one file, and the only appended prompt a coding chat has: a person's own is refused on Settings › Providers
            let arg = if through_cmd { cmd_path_arg(&f.to_string_lossy()).ok().map(OsString::from) } else { Some(f.as_os_str().to_owned()) };
            match arg {
                Some(a) => argv.extend(["--append-system-prompt-file".into(), a]),
                None => notes.unsend(),
            }
        }
        if agent_id == "opencode" && notes.file().is_some_and(|f| crate::acp_chat::with_instructions("{}", f).is_none()) {
            notes.unsend();
        }
        // the person's variables and the home they set, then the account's home, then what keeps the project's own
        // configuration out, so a variable of the person's with the same name never wins
        let mut env = crate::providers::session_env(agent_id, mine, account_env, true);
        env.extend(project_config_off(agent_id).iter().map(|(k, v)| (k.to_string(), v.to_string())));
        // an agent whose own default runs tools unasked (OpenCode) gets ask rules built from its own
        // resolved rules, so nothing the person allows runs unasked and nothing they deny becomes askable; or it does
        // not start. Its rules are read with the variables it will run with, so one of the person's that changes them is
        // read too, and the rule variable goes last, so it is the one the agent gets. OpenCode's instructions file rides in
        // the same value (`instructions`), the one way it takes them with its project configuration off.
        if let Some((probe, label)) = acp.and_then(|a| a.rules.as_ref().map(|r| (r, a.label))) {
            let rules = agent_rules(probe, label, &program, cwd, &path_env, &env, notes.file().filter(|_| agent_id == "opencode"))?;
            env.push(rules);
        }
        // nothing below refuses the start: the file now goes when the chat ends
        let note = notes.note();
        let mut gone = notes.keep();
        let mut inner = sink;
        let sink = move |out: ChatOut| {
            if matches!(out, ChatOut::Exit(..)) {
                gone.now();
            }
            inner(out)
        };
        // Claude Code's chat is handed computer use when the Mac allows it (computer/hub.rs): its asks come here as cards.
        // It is attached only now, when nothing above can still refuse the start and leave its room behind.
        let (mut argv, adapter, sink, computer) = with_computer(agent_id == "claude", argv, adapter, sink);
        // The person's arguments go after every one the app adds, computer use's included: an option of theirs that
        // wants a value and was given none then has nothing of the app's to take for it.
        argv.extend(extra);
        let started = self.spawn(argv, cwd, Some(path_env), &env, adapter, sink);
        self.bind_computer(computer.as_deref(), &started);
        // the chat says once what its agent was told: the files read, and those left out and why
        if let (Ok(id), Some(n)) = (&started, note) {
            let sink = self.live.lock().unwrap().get(id).map(|c| c.sink.clone());
            if let Some(s) = sink {
                deliver(&s, vec![ev("session.note", n)]);
            }
        }
        started
    }

    /// The home whose `~/.manut/project-notes` holds a chat's instructions file: the person's own, and in tests a
    /// temporary one unless a test names its own, so no test ever writes there.
    fn notes_home(&self) -> Option<PathBuf> {
        if let Some(h) = &self.notes_home {
            return Some(h.clone());
        }
        if cfg!(test) {
            let h = std::env::temp_dir().join(format!("manut-notes-home-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&h);
            return Some(h);
        }
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).filter(|h| !h.is_empty()).map(PathBuf::from)
    }

    /// Computer use serves only a server under the process started for its chat (`computer/hub.rs`): name that process
    /// to the hub once it runs, or let the chat's room go when it did not start.
    fn bind_computer(&self, token: Option<&str>, started: &Result<u32, String>) {
        let Some(token) = token else { return };
        let pid = started.as_ref().ok().and_then(|id| self.live.lock().unwrap().get(id).map(|c| c.pid));
        match pid {
            Some(pid) => crate::computer::hub::bind(token, pid as i32),
            None => crate::computer::hub::detach(token),
        }
    }

    /// Start Buddy's chat ([`crate::buddy_chat`]): Claude Code in its chat mode with Buddy's fixed arguments and the
    /// instructions file `prompt_file`, in Buddy's own folder `cwd`, through the same Claude adapter a coding session
    /// uses, so its asks reach the page as cards in the same way. The program comes from the allow-list, as always.
    pub fn start_buddy<F>(&self, cwd: &Path, prompt_file: &Path, account_env: &[(String, String)], sink: F) -> Result<u32, String>
    where
        F: FnMut(ChatOut) + Send + 'static,
    {
        self.start_buddy_mine(cwd, prompt_file, account_env, &crate::providers::stored_here("claude"), sink)
    }

    /// [`ChatSessions::start_buddy`] with Claude Code's Settings › Providers settings `mine`. Claude Code turned off starts
    /// no Buddy either, and the path set there is the program. Nothing else of the person's reaches Buddy's start: no extra
    /// argument (Buddy's `--permission-mode default` stays the last word on its asks) and no variable, only the home its
    /// account runs with.
    pub(crate) fn start_buddy_mine<F>(&self, cwd: &Path, prompt_file: &Path, account_env: &[(String, String)], mine: &crate::providers::Stored, sink: F) -> Result<u32, String>
    where
        F: FnMut(ChatOut) + Send + 'static,
    {
        let mut adapter = adapter_for("claude", &cwd.to_string_lossy(), None).ok_or("no chat adapter")?;
        let (launch, path_env) = crate::sessions::launch_with("claude", mine)?;
        if let Some(path) = unrecognized_program("claude") {
            adapter = Unrecognized::wrap(adapter, "claude", &path);
        }
        let argv = crate::buddy_chat::claude_argv(launch, prompt_file)?;
        // Buddy's agent may use the computer as a coding chat's may, through the same card (computer/hub.rs)
        let (argv, adapter, sink, computer) = with_computer(true, argv, adapter, sink);
        let env = crate::providers::session_env("claude", mine, account_env, false);
        let started = self.spawn(argv, cwd, Some(path_env), &env, adapter, sink);
        self.bind_computer(computer.as_deref(), &started);
        started
    }

    /// Start custom agent `c` (Settings › Agents, confirmed on its card) as a chat through the generic ACP adapter:
    /// its program resolved now, then exactly its stored arguments ([`crate::custom_agents::launch_here`]), on pipes,
    /// through no shell, with the environment a generic ACP agent gets (`account_env`, which is empty for any agent
    /// but Claude Code, Codex and Grok) and nothing more: no rule variable, no rule check. A conversation continues
    /// only inside the protocol (`session/resume`, else `session/load`), never by an argument.
    fn start_custom<F>(&self, c: &crate::custom_agents::CustomAgent, dirs: &[PathBuf], cwd: &Path, resume: Option<&str>, account_env: &[(String, String)], sink: F) -> Result<u32, String>
    where
        F: FnMut(ChatOut) + Send + 'static,
    {
        let thread = match resume {
            Some(r) if is_acp_session_id(r) => Some(r),
            Some(_) => return Err("not a conversation id".into()),
            None => None,
        };
        let adapter: Box<dyn Adapter> = Box::new(Acp::new(crate::custom_agents::adapter_row(c), &cwd.to_string_lossy(), thread).with_mcp(crate::acp_mcp::for_session(cwd)));
        let (argv, path_env) = crate::custom_agents::launch_here(c, dirs)?;
        self.spawn(argv, cwd, Some(path_env), account_env, adapter, sink)
    }

    /// Start `argv` on pipes in `cwd` with `adapter`. Crate-internal: the app reaches it only through
    /// [`ChatSessions::start_agent`], so argv always comes from the allow-list (tests use it directly).
    pub(crate) fn spawn<F>(
        &self,
        argv: Vec<OsString>,
        cwd: &Path,
        path_env: Option<OsString>,
        account_env: &[(String, String)],
        mut adapter: Box<dyn Adapter>,
        sink: F,
    ) -> Result<u32, String>
    where
        F: FnMut(ChatOut) + Send + 'static,
    {
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err(format!("not a folder: {}", cwd.display()));
        }
        let mut cmd = command_for(&argv, cwd, path_env, account_env)?;
        let mut child = cmd.spawn().map_err(|e| format!("{}: {e}", Path::new(&argv[0]).display()))?;
        let tree = Arc::new(ProcessTree::adopt(&child));
        let mut stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        let mut pipe = child.stdin.take().ok_or("no stdin")?;
        // The writer thread owns stdin, so a write to an agent that is not reading never holds a lock.
        let (tx, queued) = mpsc::sync_channel::<Vec<u8>>(INPUT_QUEUE);
        thread::spawn(move || {
            for chunk in queued {
                if pipe.write_all(&chunk).and_then(|_| pipe.flush()).is_err() {
                    break;
                }
            }
        });
        let stdin: ChatInputQueue = Arc::new(Mutex::new(Some(tx)));
        let pid = child.id();
        let sink: ChatSink = Arc::new(Mutex::new(Box::new(sink)));
        let first = adapter.start();
        let adapter: Arc<Mutex<Box<dyn Adapter>>> = Arc::new(Mutex::new(adapter));
        let exited = Arc::new(AtomicBool::new(false));
        let child = Arc::new(Mutex::new(child));
        let tail = Arc::new(Mutex::new(String::new()));
        // the program printed a protocol message (it speaks its chat mode); until then a start deadline runs
        let answered = Arc::new(AtomicBool::new(false));
        // why manut ended the session itself (the start deadline): the exit reports this instead of stderr
        let verdict: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        write_lines(&stdin, &first.write)?;
        deliver(&sink, first.events);

        let reader_done = Arc::new(AtomicBool::new(false));
        {
            // stdout: one thread reads, another merges what arrives within COALESCE_WINDOW (as PTY output is),
            // splits it on LF only (JSON strings may hold U+2028) and runs one adapter step per line.
            let (chunks, rx) = mpsc::channel::<Vec<u8>>();
            thread::spawn(move || {
                let mut buf = [0u8; 16 * 1024];
                loop {
                    match stdout.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if chunks.send(buf[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                    }
                }
            });
            let (adapter, stdin, sink, done, answered) = (adapter.clone(), stdin.clone(), sink.clone(), reader_done.clone(), answered.clone());
            thread::spawn(move || {
                let mut pending: Vec<u8> = Vec::new();
                let run = |lines: &mut dyn Iterator<Item = &[u8]>| {
                    let mut out = Step::default();
                    {
                        let mut a = adapter.lock().unwrap();
                        for raw in lines {
                            let line = String::from_utf8_lossy(raw);
                            // a BOM, or two messages on one line, still reach the adapter one message at a time
                            for msg in protocol_lines(line.trim_end_matches(['\n', '\r'])) {
                                answered.store(true, Ordering::SeqCst);
                                let step = a.on_line(msg);
                                out.write.extend(step.write);
                                out.events.extend(step.events);
                            }
                        }
                    }
                    let _ = write_lines(&stdin, &out.write);
                    deliver(&sink, merge_deltas(out.events));
                };
                coalesce(rx, COALESCE_BYTES, COALESCE_WINDOW, |b| {
                    pending.extend_from_slice(&b);
                    let Some(end) = pending.iter().rposition(|c| *c == b'\n') else { return };
                    let rest = pending.split_off(end + 1);
                    let whole = std::mem::replace(&mut pending, rest);
                    run(&mut whole.split(|c| *c == b'\n'));
                });
                if !pending.is_empty() {
                    run(&mut std::iter::once(&pending[..]));
                }
                done.store(true, Ordering::SeqCst);
            });
        }
        // set once stderr reached its end: the exit reason is read from all of it
        let err_done = Arc::new(AtomicBool::new(false));
        {
            let (tail, err_done) = (tail.clone(), err_done.clone());
            thread::spawn(move || {
                let mut r = stderr;
                let mut buf = [0u8; 4096];
                while let Ok(n) = r.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let mut t = tail.lock().unwrap();
                    t.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if t.len() > 4000 {
                        let cut = t.len() - 2000;
                        let cut = (cut..t.len()).find(|i| t.is_char_boundary(*i)).unwrap_or(t.len());
                        t.drain(..cut);
                    }
                }
                err_done.store(true, Ordering::SeqCst);
            });
        }
        {
            // the start deadline: a program that has printed no protocol message by then is not in its chat mode (an
            // old version showing its terminal UI, a hung start), so the session ends with that reason, all of it
            let (child, exited, sink, adapter, answered, verdict, tree) = (child.clone(), exited.clone(), sink.clone(), adapter.clone(), answered.clone(), verdict.clone(), tree.clone());
            let deadline = Instant::now() + self.start_deadline.unwrap_or(START_DEADLINE);
            thread::spawn(move || {
                while Instant::now() < deadline {
                    if answered.load(Ordering::SeqCst) || exited.load(Ordering::SeqCst) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                if answered.load(Ordering::SeqCst) || exited.load(Ordering::SeqCst) {
                    return;
                }
                let why = no_chat_mode(adapter.lock().unwrap().name());
                *verdict.lock().unwrap() = Some(why.clone());
                deliver(&sink, vec![ev("session.error", json!({"kind": "no_chat_mode", "message": why}))]);
                match tree.as_ref() {
                    Some(t) => t.kill(),
                    None => {
                        let _ = child.lock().unwrap().kill();
                    }
                }
            });
        }
        {
            let (child, exited, sink, adapter, done, answered, verdict) = (child.clone(), exited.clone(), sink.clone(), adapter.clone(), reader_done.clone(), answered.clone(), verdict.clone());
            let err_done = err_done.clone();
            thread::spawn(move || {
                let code = loop {
                    if let Ok(Some(st)) = child.lock().unwrap().try_wait() {
                        break st.code();
                    }
                    thread::sleep(Duration::from_millis(40));
                };
                exited.store(true, Ordering::SeqCst);
                // let the readers hand over what the program printed last (stdout's events, stderr's reason)
                let deadline = Instant::now() + Duration::from_millis(800);
                while !(done.load(Ordering::SeqCst) && err_done.load(Ordering::SeqCst)) && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(10));
                }
                let (mid_turn, err, said) = {
                    let a = adapter.lock().unwrap();
                    // code 0 is an orderly close: what it printed at start (a config warning) is no reason
                    let raw = exit_why(code, &tail.lock().unwrap());
                    match verdict.lock().unwrap().take() {
                        // the start deadline ended it, and already said so
                        Some(why) => (a.in_turn(), why, true),
                        // it never spoke its protocol and refused manut's chat-mode arguments: an old version
                        // an orderly close (code 0) failed nothing: no reason, whatever it printed
                        None if code == Some(0) => (a.in_turn(), String::new(), true),
                        None if !answered.load(Ordering::SeqCst) && !a.unrecognized() && refused_chat_mode(&raw) => (a.in_turn(), no_chat_mode(a.name()), false),
                        None => (a.in_turn(), a.explain(&raw), true),
                    }
                };
                if let Ok(mut f) = sink.lock() {
                    if !said {
                        f(ChatOut::Event(ev("session.error", json!({"kind": "no_chat_mode", "message": err}))));
                    }
                    if mid_turn {
                        f(ChatOut::Event(exit_turn_end(code, &err)));
                    }
                    f(ChatOut::Exit(code, err));
                }
            });
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        self.live.lock().unwrap().insert(id, ChatLive { stdin, adapter, sink, child, pid, tree, exited, cwd: cwd.to_path_buf() });
        Ok(id)
    }

    /// The program of every chat still running, with its id and the folder it started in: what the commands that keep
    /// running are read from ([`crate::running`]), as [`crate::sessions::Sessions::roots`] gives it for the terminals. A DSH
    /// chat has no process between its messages, so it is not here; a chat that ended is not listed.
    pub(crate) fn roots(&self) -> Vec<(u32, u32, PathBuf)> {
        let g = self.live.lock().unwrap();
        g.iter().filter(|(_, c)| !c.exited.load(Ordering::SeqCst)).map(|(id, c)| (*id, c.pid, c.cwd.clone())).collect()
    }

    /// The model values chat `id`'s agent listed in this process ([`Adapter::models`]), or none for a chat that is gone.
    pub fn models(&self, id: u32) -> Vec<String> {
        let adapter = self.live.lock().unwrap().get(&id).map(|s| s.adapter.clone());
        adapter.map(|a| a.lock().unwrap().models()).unwrap_or_default()
    }

    /// One thing the person did in chat `id`.
    pub fn input(&self, id: u32, input: Input) -> Result<(), String> {
        let dsh = self.dsh.lock().unwrap().get(&id).cloned();
        if let Some(chat) = dsh {
            return chat.input(input);
        }
        let (adapter, stdin, sink) = {
            let g = self.live.lock().unwrap();
            let s = g.get(&id).ok_or("no such session")?;
            (s.adapter.clone(), s.stdin.clone(), s.sink.clone())
        };
        let step = adapter.lock().unwrap().on_input(input)?;
        write_lines(&stdin, &step.write)?;
        deliver(&sink, step.events);
        Ok(())
    }

    /// Stop the program (stdin closed, then hang-up, then a hard kill after a grace period) and forget it.
    pub fn close(&self, id: u32) {
        if let Some(chat) = self.dsh.lock().unwrap().remove(&id) {
            thread::spawn(move || chat.stop(Duration::from_millis(1500)));
        }
        let live = self.live.lock().unwrap().remove(&id);
        if let Some(s) = live {
            thread::spawn(move || stop(s, Duration::from_millis(1500)));
        }
    }

    pub fn close_all(&self) {
        let all: Vec<ChatLive> = self.live.lock().unwrap().drain().map(|(_, s)| s).collect();
        let dsh: Vec<DshChat> = self.dsh.lock().unwrap().drain().map(|(_, c)| c).collect();
        let mut handles: Vec<_> = all.into_iter().map(|s| thread::spawn(move || stop(s, Duration::from_millis(400)))).collect();
        handles.extend(dsh.into_iter().map(|c| thread::spawn(move || c.stop(Duration::from_millis(400)))));
        for h in handles {
            let _ = h.join();
        }
    }

    #[cfg(test)]
    pub fn count(&self) -> usize {
        self.live.lock().unwrap().len() + self.dsh.lock().unwrap().len()
    }
}

fn stop(s: ChatLive, grace: Duration) {
    // closing stdin is pi's and Codex's orderly shutdown; Claude Code's -p ends on EOF too. The writer
    // thread closes it once it has nothing left to write (a stuck write ends when the program does).
    drop(s.stdin.lock().unwrap().take());
    let deadline = Instant::now() + Duration::from_millis(300).min(grace);
    while !s.exited.load(Ordering::SeqCst) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    if !s.exited.load(Ordering::SeqCst) {
        signal_group(Some(s.pid), false);
        // Windows has no hang-up: the whole tree goes now (cmd.exe and the node.exe behind an npm shim)
        #[cfg(not(unix))]
        {
            match s.tree.as_ref() {
                Some(t) => t.kill(),
                None => {
                    let _ = s.child.lock().unwrap().kill();
                }
            }
        }
    }
    let deadline = Instant::now() + grace;
    while !s.exited.load(Ordering::SeqCst) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(25));
    }
    if !s.exited.load(Ordering::SeqCst) {
        signal_group(Some(s.pid), true);
        let _ = s.child.lock().unwrap().kill();
    }
    // whatever the program started and left behind (a helper that ignores hang-up, the node.exe behind cmd.exe) goes
    // with it, also when the program itself already ended
    if let Some(t) = s.tree.as_ref() {
        t.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_chat::subagents::thinking_event;
    use crate::agent_chat::claude::Claude;
    use crate::agent_chat::pi::Pi;
    use crate::agent_chat::tests::{
        claude_up,
        collect,
        ends,
        hostile_project,
        names,
        of,
        of_kind,
        real,
        run,
        text_of,
        wait_for,
        written,
    };

    /// A stand-in rule listing: `/bin/sh -c <script>` prints its first listing, or with the variable set its second.
    #[cfg(unix)]
    fn rules_with(script: &str) -> Result<(String, String), String> {
        fn build(l: &str) -> Option<String> {
            l.strip_prefix("rules:").map(|r| r.trim().to_string())
        }
        fn kept(_first: &str, rules: &str, again: &str) -> bool {
            again.trim() == format!("kept {rules}")
        }
        const FORMS: &[crate::acp_chat::ProbeForm] = &[crate::acp_chat::ProbeForm { args: &[], build, kept }];
        let probe = RuleProbe { forms: FORMS, var: "MANUT_TEST_RULES_VAR" };
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let argv: Vec<OsString> = vec!["/bin/sh".into(), "-c".into(), script.into()];
        agent_rules(&probe, "OpenCode", &argv, &tmp, &std::env::var_os("PATH").unwrap(), &[], None)
    }

    #[test]
    #[cfg(unix)]
    fn an_agent_starts_only_with_rules_it_listed_and_kept() {
        let ok = r#"if [ -n "$MANUT_TEST_RULES_VAR" ]; then echo "kept $MANUT_TEST_RULES_VAR"; else echo "rules: R1"; fi"#;
        assert_eq!(rules_with(ok), Ok(("MANUT_TEST_RULES_VAR".to_string(), "R1".to_string())));
        // each doubt refuses the start with the one plain sentence
        for bad in [
            "exit 1",                                                                                // the listing failed
            "echo 'Error: Config file is not valid JSON'",                                           // nothing it can read
            r#"if [ -n "$MANUT_TEST_RULES_VAR" ]; then echo "kept other"; else echo "rules: R1"; fi"#, // not kept
            r#"if [ -n "$MANUT_TEST_RULES_VAR" ]; then exit 1; else echo "rules: R1"; fi"#,           // second listing failed
        ] {
            assert_eq!(rules_with(bad), Err(crate::acp_chat::NO_RULES.to_string()), "{bad}");
        }
    }

    /// Item 114: OpenCode 2.3.0, as recorded on this Mac (`tests/fixtures/acp/opencode2-rules.json`), one case of it. A
    /// stand-in answers as it did: `agent list` prints the help and ends with code 1, `debug agents --standalone` lists the
    /// agents as JSON, and with the rule variable set lists them with the rules OpenCode was started with.
    #[cfg(unix)]
    fn opencode_2_3(case: &str, second: &str) -> (std::path::PathBuf, String, Vec<OsString>) {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("acp").join("opencode2-rules.json");
        let all: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
        // a folder of its own for every call: the tests run at once in one process
        static CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = CALLS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("manut-oc23-{case}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let text = |k: &str| all[case][k].as_str().unwrap_or_default().to_string();
        std::fs::write(dir.join("help"), all["agent_list"].as_str().unwrap()).unwrap();
        std::fs::write(dir.join("base"), text("debug_agents")).unwrap();
        std::fs::write(dir.join("second"), if second.is_empty() { text("debug_agents_in_manut") } else { second.to_string() }).unwrap();
        let d = dir.display();
        // every listing the stand-in is asked for is noted, so a test sees which forms ran
        let script = format!(
            r#"echo "$*" >> '{d}/asked'; case "$*" in "debug agents --standalone") if [ -n "$OPENCODE_CONFIG_CONTENT" ]; then printf '%s' "$OPENCODE_CONFIG_CONTENT" > '{d}/listed-with'; cat '{d}/second'; else cat '{d}/base'; fi;; *) cat '{d}/help'; exit 1;; esac"#
        );
        (dir, text("env_sent"), vec!["/bin/sh".into(), "-c".into(), script.into(), "sh".into()])
    }

    #[test]
    #[cfg(unix)]
    fn an_opencode_that_lists_its_agents_the_2_3_way_starts_with_its_own_rules_kept() {
        let row = acp_agent("opencode").unwrap();
        let probe = row.rules.as_ref().unwrap();
        for case in ["none", "pattern-deny", "allow", "string-deny", "star-deny"] {
            let (dir, sent, argv) = opencode_2_3(case, "");
            assert_eq!(agent_rules(probe, row.label, &argv, &dir, &std::env::var_os("PATH").unwrap(), &[], None), Ok((probe.var.to_string(), sent)), "{case}");
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// The rest of the class: a 2.3 listing the rules were not kept in refuses the chat, and so does one of either form that
    /// cannot be read. A listing whose rules were read but not kept never moves on to the other form.
    #[test]
    #[cfg(unix)]
    fn an_opencode_2_3_that_did_not_keep_the_rules_or_cannot_be_read_does_not_start() {
        let row = acp_agent("opencode").unwrap();
        let probe = row.rules.as_ref().unwrap();
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("acp").join("opencode2-rules.json");
        let all: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
        let base = all["none"]["debug_agents"].as_str().unwrap().to_string();
        let kept = all["none"]["debug_agents_in_manut"].as_str().unwrap_or_default().to_string();
        let mut later_allow: serde_json::Value = serde_json::from_str(&kept).unwrap_or_default();
        if let Some(perms) = later_allow.get_mut(0).and_then(|a| a.get_mut("permissions")).and_then(|p| p.as_array_mut()) {
            perms.push(serde_json::json!({"action": "shell", "resource": "*", "effect": "allow"}));
        }
        for (what, second) in [
            ("the rules not taken: the same listing again", base.clone()),
            ("an allow put back after the rules", later_allow.to_string()),
            ("a listing that is not JSON", "Error: something went wrong".to_string()),
            ("an empty list", "[]".to_string()),
        ] {
            let (dir, _, argv) = opencode_2_3("none", &second);
            assert_eq!(agent_rules(probe, row.label, &argv, &dir, &std::env::var_os("PATH").unwrap(), &[], None), Err(no_rules(row.label)), "{what}");
            let asked = std::fs::read_to_string(dir.join("asked")).unwrap_or_default();
            assert!(!asked.contains("agent list"), "{what}: the other form was tried after rules that were not kept: {asked}");
            let _ = std::fs::remove_dir_all(dir);
        }
        // neither form readable: an agent whose listings both fail
        for (what, first) in [("not JSON", "Error: Config file is not valid JSON"), ("no build agent", r#"[{"id":"builder","mode":"primary","permissions":[]}]"#), ("an effect it does not know", r#"[{"id":"build","mode":"primary","permissions":[{"action":"*","resource":"*","effect":"maybe"}]}]"#), ("no permissions", r#"[{"id":"build","mode":"primary"}]"#), ("a mode it does not know", r#"[{"id":"build","mode":"primary","permissions":[]},{"id":"x","mode":"new-mode","permissions":[]}]"#)] {
            let (dir, _, argv) = opencode_2_3("none", "");
            std::fs::write(dir.join("base"), first).unwrap();
            assert_eq!(agent_rules(probe, row.label, &argv, &dir, &std::env::var_os("PATH").unwrap(), &[], None), Err(no_rules(row.label)), "{what}");
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// An older OpenCode (1.x), which has no `debug agents` but `agent list`, still starts with its rules kept: the stand-in
    /// answers the new listing with an error, and the old one with the recorded 1.19.5 listings.
    #[test]
    #[cfg(unix)]
    fn an_older_opencode_that_lists_its_agents_with_agent_list_still_starts() {
        let row = acp_agent("opencode").unwrap();
        let probe = row.rules.as_ref().unwrap();
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("acp").join("opencode-rules.json");
        let all: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
        let dir = std::env::temp_dir().join(format!("manut-oc119-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        std::fs::write(dir.join("base"), all["pattern-deny"]["agent_list"].as_str().unwrap()).unwrap();
        std::fs::write(dir.join("second"), all["pattern-deny"]["agent_list_in_manut"].as_str().unwrap()).unwrap();
        let d = dir.display();
        let script = format!(
            r#"case "$*" in "agent list") if [ -n "$OPENCODE_CONFIG_CONTENT" ]; then cat '{d}/second'; else cat '{d}/base'; fi;; *) echo "Unknown command: $*" >&2; exit 1;; esac"#
        );
        let argv: Vec<OsString> = vec!["/bin/sh".into(), "-c".into(), script.into(), "sh".into()];
        let got = agent_rules(probe, row.label, &argv, &dir, &std::env::var_os("PATH").unwrap(), &[], None);
        assert!(got.as_ref().is_ok_and(|(var, value)| var == probe.var && value.contains("\"bash *\"")), "{got:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The join of item 93 and item 114: OpenCode 2.3.0 (its recorded listings) with the project's instructions file. The value
    /// OpenCode is listed again with, and then started with, holds all three parts in one object: the ask rules, the formatter
    /// and language server switches, and the one `instructions` entry; the rules are checked as sent. A second listing that
    /// did not keep the rules refuses the start, the instructions entry or not; and so does the older form, the same way.
    #[test]
    #[cfg(unix)]
    fn opencode_2_3_with_an_instructions_file_is_checked_with_the_whole_value_it_starts_with() {
        const FILE: &str = "/home/me/.manut/project-notes/1-2-3.md";
        let row = acp_agent("opencode").unwrap();
        let probe = row.rules.as_ref().unwrap();
        let path = std::env::var_os("PATH").unwrap();
        for case in ["none", "pattern-deny"] {
            let (dir, rules, argv) = opencode_2_3(case, "");
            let got = agent_rules(probe, row.label, &argv, &dir, &path, &[], Some(Path::new(FILE))).unwrap();
            let v: serde_json::Value = serde_json::from_str(&got.1).unwrap();
            assert!(v["agent"]["build"]["permission"]["shell *"].is_object(), "{case}: the ask rules");
            assert_eq!((&v["formatter"], &v["lsp"]), (&json!(false), &json!(false)), "{case}: the switches");
            assert_eq!(v["instructions"], json!([FILE]), "{case}: the one instructions entry");
            // the rules text byte for byte, then the entry: exactly what the listing was made with and what starts
            assert_eq!(got.1, crate::acp_chat::with_instructions(&rules, Path::new(FILE)).unwrap(), "{case}");
            assert_eq!(std::fs::read_to_string(dir.join("listed-with")).unwrap(), got.1, "{case}: listed again with another value");
            let _ = std::fs::remove_dir_all(dir);
        }
        // the second listing did not keep the rules: the same listing back, as if the value had been dropped
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("acp").join("opencode2-rules.json");
        let all: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
        let (dir, _, argv) = opencode_2_3("none", all["none"]["debug_agents"].as_str().unwrap());
        assert_eq!(agent_rules(probe, row.label, &argv, &dir, &path, &[], Some(Path::new(FILE))), Err(no_rules(row.label)));
        assert!(!std::fs::read_to_string(dir.join("asked")).unwrap_or_default().contains("agent list"));
        let _ = std::fs::remove_dir_all(dir);
        // a path the value cannot carry refuses before anything is listed again
        let (dir, _, argv) = opencode_2_3("none", "");
        assert_eq!(agent_rules(probe, row.label, &argv, &dir, &path, &[], Some(Path::new("/x/{file:/etc/passwd}/1.md"))), Err(no_rules(row.label)));
        assert!(!dir.join("listed-with").exists());
        let _ = std::fs::remove_dir_all(dir);
        // the older form (1.19.5's recorded listings) carries the same entry after its own rules and switches
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("acp").join("opencode-rules.json");
        let old: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
        let dir = std::env::temp_dir().join(format!("manut-oc119-notes-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        std::fs::write(dir.join("base"), old["pattern-deny"]["agent_list"].as_str().unwrap()).unwrap();
        std::fs::write(dir.join("second"), old["pattern-deny"]["agent_list_in_manut"].as_str().unwrap()).unwrap();
        let d = dir.display();
        let script = format!(
            r#"case "$*" in "agent list") if [ -n "$OPENCODE_CONFIG_CONTENT" ]; then printf '%s' "$OPENCODE_CONFIG_CONTENT" > '{d}/listed-with'; cat '{d}/second'; else cat '{d}/base'; fi;; *) exit 1;; esac"#
        );
        let argv: Vec<OsString> = vec!["/bin/sh".into(), "-c".into(), script.into(), "sh".into()];
        let got = agent_rules(probe, row.label, &argv, &dir, &path, &[], Some(Path::new(FILE))).unwrap();
        let v: serde_json::Value = serde_json::from_str(&got.1).unwrap();
        assert!(v["agent"]["build"]["permission"]["bash *"].is_object() && v["formatter"] == json!(false) && v["lsp"] == json!(false) && v["instructions"] == json!([FILE]), "{}", got.1);
        assert_eq!(std::fs::read_to_string(dir.join("listed-with")).unwrap(), got.1);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Item 93: OpenCode's instructions file joins the rule value as its `instructions` entry before the second listing, so
    /// the rules are checked with the very value OpenCode gets, and `kept` still compares the rules alone.
    #[test]
    #[cfg(unix)]
    fn opencodes_instructions_file_rides_in_the_rule_value_it_was_checked_with() {
        const FILE: &str = "/home/me/.manut/project-notes/1-2-3.md";
        fn build(l: &str) -> Option<String> {
            l.strip_prefix("rules:").map(|r| r.trim().to_string())
        }
        fn kept(_first: &str, rules: &str, again: &str) -> bool {
            rules == r#"{"agent":{}}"# && again.trim() == format!("kept {}", crate::acp_chat::with_instructions(rules, Path::new(FILE)).unwrap())
        }
        const FORMS: &[crate::acp_chat::ProbeForm] = &[crate::acp_chat::ProbeForm { args: &[], build, kept }];
        let probe = RuleProbe { forms: FORMS, var: "MANUT_TEST_RULES_VAR" };
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let script = r#"if [ -n "$MANUT_TEST_RULES_VAR" ]; then echo "kept $MANUT_TEST_RULES_VAR"; else echo 'rules: {"agent":{}}'; fi"#;
        let argv: Vec<OsString> = vec!["/bin/sh".into(), "-c".into(), script.into()];
        let path = std::env::var_os("PATH").unwrap();
        assert_eq!(
            agent_rules(&probe, "OpenCode", &argv, &tmp, &path, &[], Some(Path::new(FILE))),
            Ok(("MANUT_TEST_RULES_VAR".to_string(), r#"{"agent":{},"instructions":["/home/me/.manut/project-notes/1-2-3.md"]}"#.to_string()))
        );
        // a path the value cannot carry refuses the start rather than leaving the entry out unchecked
        assert_eq!(agent_rules(&probe, "OpenCode", &argv, &tmp, &path, &[], Some(Path::new("/x/{env:HOME}/1.md"))), Err(no_rules("OpenCode")));
    }

    /// A listed pattern or agent name is not trusted config text: no second listing with a file/env token that
    /// the CLI would substitute before the preservation proof can run.
    #[test]
    #[cfg(unix)]
    fn a_config_token_refuses_before_the_second_listing() {
        let dir = std::env::temp_dir().join(format!("manut-token-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let absent = dir.join("not-a-file.txt");
        assert!(!absent.exists());
        for id in ["opencode"] {
            let row = acp_agent(id).unwrap();
            let probe = row.rules.as_ref().unwrap();
            let primary = "build";
            for token in [format!("${{file:{}}}", absent.display()), format!("{{file:{}}}", absent.display()), "${env:HOME}".into(), "{env:HOME}".into()] {
                let first = format!("{primary} (primary)\n{}\n", json!([{"permission":"bash", "pattern":token, "action":"deny"}]));
                // /bin/sh is a listing stand-in only: the marker would be written before the second listing's
                // config was parsed. No file named by the token exists, and no second process is started.
                let marker = dir.join("listed-again");
                let script = format!("if [ -n \"${}\" ]; then printf again > '{}'; exit 1; fi; printf '%s' '{}'", probe.var, marker.display(), first);
                let argv = ["/bin/sh".into(), "-c".into(), script.into()];
                assert_eq!(agent_rules(probe, row.label, &argv, &dir, &std::env::var_os("PATH").unwrap(), &[], None), Err(no_rules(row.label)));
                assert!(!marker.exists(), "{id}: second listing ran for {token}");
                assert!(!absent.exists());
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_attachment_folder_is_one_add_dir_argument() {
        // one argv element, spaces and all, exactly the folder given: never split, never a parent
        let dir = Path::new("/Users/me/.manut/session-files/s12");
        assert_eq!(add_dir_args(&OsString::from("/opt/bin/claude"), dir), [OsString::from("--add-dir"), OsString::from("/Users/me/.manut/session-files/s12")]);
        let spaced = Path::new("/Users/Jane Doe/.manut/session-files/s3");
        assert_eq!(add_dir_args(&OsString::from("/opt/bin/claude"), spaced), [OsString::from("--add-dir"), OsString::from("/Users/Jane Doe/.manut/session-files/s3")]);
        // through `cmd.exe /c` (a Windows .cmd shim) the folder goes as cmd allows it, or not at all
        assert_eq!(add_dir_args(&OsString::from("cmd.exe"), Path::new(r"C:\Users\a&b\.manut\session-files\s1")), [OsString::from("--add-dir"), OsString::from(r"C:\Users\a^&b\.manut\session-files\s1")]);
        assert!(add_dir_args(&OsString::from("cmd.exe"), Path::new(r"C:\Users\50%\.manut\session-files\s1")).is_empty());
    }

    #[test]
    fn only_chat_agents_have_adapters() {
        let generic = crate::acp_agents::ACP_LIST.iter().map(|e| e.agent.id);
        for id in ["claude", "codex", "omo", "pi", "omp", "opencode"].into_iter().chain(generic) {
            assert!(adapter_for(id, "/w", None).is_some(), "{id}");
        }
        // DSH has no adapter: its chat is a run per message (dsh_chat); Kilo Code is no longer offered
        for id in ["omh", "grok", "dsh", "sh", "", "kilo"] {
            assert!(adapter_for(id, "/w", None).is_none(), "{id}");
        }
        let c = ChatSessions::default();
        let tmp = std::env::temp_dir();
        assert!(c.start_agent("dsh", &tmp, Some("eee5079a-c52e-4526-b633-f3d8cb7d6394"), &[], None, |_| {}).is_err());
        for bad in ["omh", "grok", "/bin/sh", "claude -p"] {
            assert!(c.start_agent(bad, &tmp, None, &[], None, |_| {}).is_err(), "{bad}");
        }
        // Kilo Code and any other id are refused as unknown, before a program is looked up
        for gone in ["kilo", "kilo acp", "Gemini", "gemini --yolo"] {
            assert_eq!(c.start_agent(gone, &tmp, None, &[], None, |_| {}).unwrap_err(), format!("unknown agent \"{gone}\""));
        }
        assert!(c.start_agent("claude", &tmp, Some("--dangerously-skip-permissions"), &[], None, |_| {}).is_err());
        assert!(c.start_agent("opencode", &tmp, Some("ses_x --yolo"), &[], None, |_| {}).is_err());
        assert_eq!(c.count(), 0);
    }

    /// A stand-in program at `<dir>/<name>` that writes each argument it got on a line of `<dir>/<name>.seen`, then
    /// `VAR=<$MY_TOKEN>` and `HOME_VAR=<$CLAUDE_CONFIG_DIR>`, and exits.
    #[cfg(unix)]
    fn recorder(dir: &Path, name: &str) -> (PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let prog = dir.join(name);
        let seen = dir.join(format!("{name}.seen"));
        let body = format!(
            "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > '{s}.tmp'\nprintf 'VAR=%s\\nHOME_VAR=%s\\n' \"$MY_TOKEN\" \"$CLAUDE_CONFIG_DIR\" >> '{s}.tmp'\nmv '{s}.tmp' '{s}'\n",
            s = seen.display()
        );
        std::fs::write(&prog, body).unwrap();
        std::fs::set_permissions(&prog, std::fs::Permissions::from_mode(0o755)).unwrap();
        (prog, seen)
    }

    #[cfg(unix)]
    fn seen_lines(seen: &Path) -> Vec<String> {
        assert!(wait_for(|| seen.exists(), 20), "{} never ran", seen.display());
        std::fs::read_to_string(seen).unwrap().lines().map(str::to_string).collect()
    }

    /// Settings › Providers (item 74) on a real chat start: a turned-off agent starts no process at all; the path set is
    /// the program; the app's own arguments come first and unchanged, the person's after them; their variables and the home
    /// they set reach the process; an added account's home wins over that home. Buddy, with the very same settings, gets
    /// none of the person's arguments or variables, so its `--permission-mode default` stays the last word.
    #[cfg(unix)]
    #[test]
    fn providers_settings_reach_a_chat_and_never_weaken_its_start() {
        use crate::providers::{Stored, Var};
        let base = std::env::temp_dir().join(format!("manut-prov-chat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let dir = base.canonicalize().unwrap();
        let (prog, seen) = recorder(&dir, "fake-claude");
        let home = dir.join("claude-home");
        std::fs::create_dir_all(&home).unwrap();
        let c = ChatSessions::default();

        let off = Stored { off: true, path: prog.to_string_lossy().into_owned(), ..Stored::default() };
        assert!(c.start_agent_mine("claude", &dir, None, &[], None, false, &off, |_| {}).unwrap_err().contains("turned off"));
        assert!(c.start_buddy_mine(&dir, &dir.join("p.md"), &[], &off, |_| {}).unwrap_err().contains("turned off"));
        thread::sleep(Duration::from_millis(200));
        assert!(!seen.exists() && c.count() == 0, "a turned-off agent started");

        let mine = Stored {
            path: prog.to_string_lossy().into_owned(),
            home: home.to_string_lossy().into_owned(),
            args: vec!["--model=opus".into(), "--effort=high".into()],
            env: vec![Var { name: "MY_TOKEN".into(), value: "t0ken-value".into() }],
            ..Stored::default()
        };
        c.start_agent_mine("claude", &dir, None, &[], None, false, &mine, |_| {}).unwrap();
        let mut want: Vec<String> = crate::sessions::CLAUDE_CHAT_ARGS.iter().map(|a| a.to_string()).collect();
        want.extend(["--permission-mode".to_string(), "default".to_string()]);
        want.extend(["--model=opus".to_string(), "--effort=high".to_string()]);
        want.push("VAR=t0ken-value".into());
        want.push(format!("HOME_VAR={}", home.display()));
        assert_eq!(seen_lines(&seen), want);

        // a refused argument in the file (changed by hand) starts nothing
        std::fs::remove_file(&seen).unwrap();
        let bad = Stored { args: vec!["--dangerously-skip-permissions".into()], ..mine.clone() };
        assert!(c.start_agent_mine("claude", &dir, None, &[], None, false, &bad, |_| {}).unwrap_err().contains("arg_skips"));
        thread::sleep(Duration::from_millis(200));
        assert!(!seen.exists());

        // an added account's home replaces the one set here
        let acct = vec![("CLAUDE_CONFIG_DIR".to_string(), "/h/.manut/accounts/claude/work".to_string())];
        c.start_agent_mine("claude", &dir, None, &acct, None, false, &mine, |_| {}).unwrap();
        assert_eq!(seen_lines(&seen).last().map(String::as_str), Some("HOME_VAR=/h/.manut/accounts/claude/work"));

        // Buddy: its own fixed arguments, the instructions file, and nothing of the person's but the home
        std::fs::remove_file(&seen).unwrap();
        let prompt = dir.join("buddy-prompt.md");
        std::fs::write(&prompt, "Buddy").unwrap();
        c.start_buddy_mine(&dir, &prompt, &[], &mine, |_| {}).unwrap();
        let mut want: Vec<String> = crate::sessions::CLAUDE_CHAT_ARGS.iter().chain(crate::buddy_chat::BUDDY_CLAUDE_ARGS.iter()).map(|a| a.to_string()).collect();
        want.push("--append-system-prompt-file".into());
        want.push(prompt.to_string_lossy().into_owned());
        want.push("VAR=".into());
        want.push(format!("HOME_VAR={}", home.display()));
        assert_eq!(seen_lines(&seen), want);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The one value of option `flag` in `argv`: present exactly once, as its own argument followed by its value, and never
    /// in the `--flag=value` form, which a second reader could take differently.
    #[cfg(unix)]
    fn the_one(argv: &[String], flag: &str) -> Option<String> {
        let at: Vec<usize> = argv.iter().enumerate().filter(|(_, a)| *a == flag).map(|(i, _)| i).collect();
        let joined = argv.iter().any(|a| a.starts_with(&format!("{flag}=")));
        (at.len() == 1 && !joined).then(|| argv.get(at[0] + 1).cloned()).flatten()
    }

    /// Item 89 (security review, 26 Nov 2026). A chat's Claude Code runs headless (`-p`), and `claude --help` says its
    /// "workspace trust dialog is skipped" there, so a repository's own files would act in every chat the app starts: its
    /// hooks run, its local allow rules and its `.mcp.json` servers apply unasked (Claude Code's permissions page, "What runs
    /// before you trust a folder", the `claude -p` column). Each chat, a lane's or not, and Buddy's, therefore loads the
    /// person's own settings alone (`--setting-sources user`, which the same page names for exactly this), and starts in a
    /// permission mode named on its command line, the careful one when the page named none, so neither a project file nor a
    /// `defaultMode` anywhere chooses it.
    #[cfg(unix)]
    #[test]
    fn a_projects_own_files_never_decide_what_a_chats_claude_code_may_do() {
        use crate::providers::Stored;
        let base = std::env::temp_dir().join(format!("manut-lane-trust-claude-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let dir = base.canonicalize().unwrap();
        let (prog, seen) = recorder(&dir, "fake-claude");
        let project = dir.join("project");
        hostile_project(&project);
        let c = ChatSessions::default();
        let mine = Stored { path: prog.to_string_lossy().into_owned(), ..Stored::default() };
        c.start_agent_mine("claude", &project, None, &[], None, false, &mine, |_| {}).unwrap();
        let argv = seen_lines(&seen);
        assert_eq!(the_one(&argv, "--setting-sources").as_deref(), Some("user"), "{argv:?}");
        assert_eq!(the_one(&argv, "--permission-mode").as_deref(), Some("default"), "{argv:?}");
        for never in ["--settings", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--allowedTools", "--allowed-tools", "bypassPermissions", "dontAsk", "auto", "acceptEdits"] {
            assert!(!argv.iter().any(|a| a == never), "{never}: {argv:?}");
        }
        // a mode the person picked is the one named, after the chat mode's own arguments and before theirs
        for m in modes_for("claude") {
            std::fs::remove_file(&seen).unwrap();
            c.start_agent_mine_in("claude", &project, None, &[], None, false, Some(m), &mine, |_| {}).unwrap();
            let argv = seen_lines(&seen);
            assert_eq!(the_one(&argv, "--permission-mode").as_deref(), Some(*m), "{argv:?}");
            assert_eq!(the_one(&argv, "--setting-sources").as_deref(), Some("user"), "{argv:?}");
        }
        // a mode the app does not offer, or anything spelled like one, starts nothing at all
        std::fs::remove_file(&seen).unwrap();
        for bad in ["bypassPermissions", "dontAsk", "auto", "manual", "Default", "default ", "", "plan\0", "--dangerously-skip-permissions", "default --settings={}", "read-only"] {
            assert!(c.start_agent_mine_in("claude", &project, None, &[], None, false, Some(bad), &mine, |_| {}).is_err(), "{bad:?}");
        }
        // an agent with no modes here takes none, and Codex none of Claude Code's
        assert!(c.start_agent_mine_in("pi", &project, None, &[], None, false, Some("default"), &mine, |_| {}).unwrap_err().contains("no permission mode"));
        assert!(c.start_agent_mine_in("codex", &project, None, &[], None, false, Some("default"), &mine, |_| {}).is_err());
        assert!(c.start_agent_mine_in("gemini", &project, None, &[], None, false, Some("plan"), &mine, |_| {}).is_err());
        thread::sleep(Duration::from_millis(200));
        assert!(!seen.exists(), "a refused mode started a program");
        // Buddy's chat runs in its own empty folder, and reads the person's own settings alone all the same
        let prompt = dir.join("buddy-prompt.md");
        std::fs::write(&prompt, "Buddy").unwrap();
        c.start_buddy_mine(&project, &prompt, &[], &mine, |_| {}).unwrap();
        let argv = seen_lines(&seen);
        assert_eq!(the_one(&argv, "--setting-sources").as_deref(), Some("user"), "{argv:?}");
        assert_eq!(the_one(&argv, "--permission-mode").as_deref(), Some("default"), "{argv:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Item 93. `--setting-sources user` keeps a project's CLAUDE.md and rules from Claude Code too, so the app reads them
    /// as plain text and hands them over with `--append-system-prompt-file`: one file, the app's own, outside the project,
    /// with the fixed lines first, removed when the chat ends; the chat says once what was read. A project with no
    /// instruction file passes nothing and says nothing, and the item 89 switches stay on the command line.
    #[cfg(unix)]
    #[test]
    fn a_claude_chat_is_handed_the_projects_own_instructions_as_text() {
        use crate::providers::Stored;
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("manut-notes-chat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let dir = base.canonicalize().unwrap();
        // a stand-in Claude Code: it writes its arguments and a copy of the instructions file it was named, then waits for its
        // input to close, as a chat's program does. Waiting for one line only let it end as soon as the app wrote its first
        // line, and on a busy machine the chat was then over, and its file rightly gone, before the test looked for it.
        let prog = dir.join("fake-claude");
        let seen = dir.join("seen");
        let copy = dir.join("prompt.copy");
        let body = format!(
            "#!/bin/sh\nprev=\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; if [ \"$prev\" = --append-system-prompt-file ]; then cat \"$a\" > '{c}'; fi; prev=$a; done > '{s}.tmp'\nmv '{s}.tmp' '{s}'\nwhile read l; do :; done\n",
            s = seen.display(),
            c = copy.display()
        );
        std::fs::write(&prog, body).unwrap();
        std::fs::set_permissions(&prog, std::fs::Permissions::from_mode(0o755)).unwrap();
        let project = dir.join("project");
        hostile_project(&project);
        std::fs::create_dir_all(project.join(".git")).unwrap();
        std::fs::write(project.join("CLAUDE.md"), "Use tabs.\n@/etc/passwd\n").unwrap();
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let mut c = ChatSessions::default();
        c.notes_home = Some(home.clone());
        let mine = Stored { path: prog.to_string_lossy().into_owned(), ..Stored::default() };
        let events: Arc<Mutex<Vec<Value>>> = Arc::default();
        let got = events.clone();
        let id = c
            .start_agent_mine("claude", &project, None, &[], None, false, &mine, move |out| {
                if let ChatOut::Event(e) = out {
                    got.lock().unwrap().push(e);
                }
            })
            .unwrap();
        let argv = seen_lines(&seen);
        assert_eq!(the_one(&argv, "--setting-sources").as_deref(), Some("user"), "{argv:?}");
        assert_eq!(the_one(&argv, "--permission-mode").as_deref(), Some("default"), "{argv:?}");
        let file = PathBuf::from(the_one(&argv, "--append-system-prompt-file").expect("one instructions file"));
        assert!(file.starts_with(crate::project_notes::notes_dir(&home)), "{file:?}");
        assert!(!file.starts_with(&project), "{file:?}");
        assert!(file.exists(), "kept while the chat runs");
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        let text = std::fs::read_to_string(&copy).unwrap();
        assert!(text.starts_with(crate::project_notes::HEAD), "{text}");
        assert!(text.contains("\nContents of CLAUDE.md:\nUse tabs.\n@/etc/passwd\n"), "{text}");
        assert!(!text.contains("root:"), "an import is never followed");
        let note = json!({"event": "session.note", "kind": "instructions", "read": ["CLAUDE.md"], "left": []});
        assert!(wait_for(|| events.lock().unwrap().contains(&note), 10), "{:?}", events.lock().unwrap());
        // the chat ends: its file goes with it
        c.close(id);
        assert!(wait_for(|| !file.exists(), 10), "{file:?} outlived its chat");
        assert_eq!(events.lock().unwrap().iter().filter(|e| e["kind"] == "instructions").count(), 1, "said once");

        // no instruction file: nothing passed, nothing said
        std::fs::remove_file(project.join("CLAUDE.md")).unwrap();
        std::fs::remove_file(&seen).unwrap();
        events.lock().unwrap().clear();
        let got = events.clone();
        let id = c
            .start_agent_mine("claude", &project, None, &[], None, false, &mine, move |out| {
                if let ChatOut::Event(e) = out {
                    got.lock().unwrap().push(e);
                }
            })
            .unwrap();
        let argv = seen_lines(&seen);
        assert!(!argv.iter().any(|a| a == "--append-system-prompt-file"), "{argv:?}");
        assert_eq!(the_one(&argv, "--setting-sources").as_deref(), Some("user"), "{argv:?}");
        thread::sleep(Duration::from_millis(300));
        assert!(!events.lock().unwrap().iter().any(|e| e["event"] == "session.note"));
        c.close(id);
        assert_eq!(std::fs::read_dir(crate::project_notes::notes_dir(&home)).unwrap().count(), 0);

        // a refused start leaves no file behind
        std::fs::write(project.join("CLAUDE.md"), "Use tabs.\n").unwrap();
        let bad = Stored { args: vec!["--dangerously-skip-permissions".into()], ..mine.clone() };
        assert!(c.start_agent_mine("claude", &project, None, &[], None, false, &bad, |_| {}).is_err());
        assert_eq!(std::fs::read_dir(crate::project_notes::notes_dir(&home)).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A stand-in `codex app-server` at `<dir>/<name>`: it answers `initialize` and writes every later line it is sent to
    /// `<dir>/<name>.seen`, so a test reads the conversation's start exactly as Codex would get it.
    #[cfg(unix)]
    fn codex_listener(dir: &Path, name: &str) -> (PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let prog = dir.join(name);
        let seen = dir.join(format!("{name}.seen"));
        let body = format!("#!/bin/sh\nread l\nprintf '%s\\n' '{{\"id\":1,\"result\":{{}}}}'\nwhile read l; do printf '%s\\n' \"$l\" >> '{s}'; done\n", s = seen.display());
        std::fs::write(&prog, body).unwrap();
        std::fs::set_permissions(&prog, std::fs::Permissions::from_mode(0o755)).unwrap();
        (prog, seen)
    }

    /// The `thread/start` (or `thread/resume`) line a stand-in Codex was sent.
    #[cfg(unix)]
    fn thread_line(seen: &Path) -> Value {
        let found = wait_for(|| std::fs::read_to_string(seen).is_ok_and(|t| t.contains("\"thread/")), 20);
        assert!(found, "Codex was never asked for a thread");
        let text = std::fs::read_to_string(seen).unwrap();
        text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).find(|v| s(v, "method").starts_with("thread/")).unwrap()
    }

    /// Item 89, the same for Codex: its project configuration (`.codex/config.toml`, which a lane may hold) or the person's own
    /// can set an approval policy that never asks and a sandbox with full access. The chat's thread starts in the mode the page
    /// named, the careful one (Ask: `untrusted`, `workspace-write`) when it named none, so Kit's dial sees Codex's asks from the
    /// first turn.
    #[cfg(unix)]
    #[test]
    fn a_codex_chat_starts_its_thread_in_a_mode_the_app_named() {
        use crate::providers::Stored;
        let base = std::env::temp_dir().join(format!("manut-lane-trust-codex-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let dir = base.canonicalize().unwrap();
        std::fs::create_dir_all(dir.join(".codex")).unwrap();
        std::fs::write(dir.join(".codex/config.toml"), "approval_policy = \"never\"\nsandbox_mode = \"danger-full-access\"\n").unwrap();
        let (prog, seen) = codex_listener(&dir, "fake-codex");
        let c = ChatSessions::default();
        let mine = Stored { path: prog.to_string_lossy().into_owned(), ..Stored::default() };
        c.start_agent_mine("codex", &dir, None, &[], None, false, &mine, |_| {}).unwrap();
        let t = thread_line(&seen);
        assert_eq!(s(&t, "method"), "thread/start");
        assert_eq!((s(&t["params"], "approvalPolicy"), s(&t["params"], "sandbox")), ("untrusted".into(), "workspace-write".into()), "{t}");
        c.close_all();
        // each mode the person can pick, named at the start, and the same for a thread that continues
        for (m, policy, sandbox) in [("read-only", "on-request", "read-only"), ("ask", "untrusted", "workspace-write"), ("auto", "on-request", "workspace-write")] {
            for resume in [None, Some("01a1cad5-b3bb-7f52-9de5-0bfc4cd293f4")] {
                let _ = std::fs::remove_file(&seen);
                c.start_agent_mine_in("codex", &dir, resume, &[], None, false, Some(m), &mine, |_| {}).unwrap();
                let t = thread_line(&seen);
                assert_eq!(s(&t, "method"), if resume.is_some() { "thread/resume" } else { "thread/start" });
                assert_eq!((s(&t["params"], "approvalPolicy"), s(&t["params"], "sandbox")), (policy.into(), sandbox.into()), "{m}: {t}");
                c.close_all();
            }
        }
        // and its first turn carries the same, with no mode message from the page
        let mut x = Codex::new("/w/proj", None).starting_in("read-only");
        x.start();
        let w = written(&run(&mut x, &[r#"{"id":1,"result":{}}"#.into()]));
        assert_eq!((s(&w[1]["params"], "approvalPolicy"), s(&w[1]["params"], "sandbox")), ("on-request".into(), "read-only".into()));
        run(&mut x, &[r#"{"id":2,"result":{"thread":{"id":"t"},"model":"m","approvalPolicy":"on-request","sandbox":{"type":"readOnly"}}}"#.into()]);
        let t = written(&x.on_input(Input::send("hi")).unwrap())[0].clone();
        assert_eq!((s(&t["params"], "approvalPolicy"), s(&t["params"]["sandboxPolicy"], "type")), ("on-request".into(), "readOnly".into()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Item 89, OpenCode: a project's `opencode.json` and `.opencode` folder can set its permissions, start MCP servers and
    /// load plugins, and OpenCode has no folder trust. Its chats start with `OPENCODE_DISABLE_PROJECT_CONFIG=1` (OpenCode's
    /// CLI documentation; on OpenCode 2.3.0 `opencode debug config` then lists neither of the two as a source, while the
    /// person's own configuration and the app's ask rules stay). The rule listing runs with exactly the variables the chat
    /// gets, so a stand-in that records them shows what OpenCode would be started with, and a variable of the person's
    /// with the same name never wins.
    #[cfg(unix)]
    #[test]
    fn an_opencode_chat_reads_no_project_configuration() {
        use crate::providers::{Stored, Var};
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("manut-lane-trust-opencode-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let dir = base.canonicalize().unwrap();
        std::fs::write(dir.join("opencode.json"), r#"{"permission":{"bash":"allow","edit":"allow"},"mcp":{"x":{"type":"local","command":["/bin/sh","-c","id"]}}}"#).unwrap();
        let prog = dir.join("fake-opencode");
        let seen = dir.join("fake-opencode.seen");
        std::fs::write(&prog, format!("#!/bin/sh\nprintf 'OFF=%s\\n' \"$OPENCODE_DISABLE_PROJECT_CONFIG\" > '{s}.tmp'\nmv '{s}.tmp' '{s}'\nexit 1\n", s = seen.display())).unwrap();
        std::fs::set_permissions(&prog, std::fs::Permissions::from_mode(0o755)).unwrap();
        let c = ChatSessions::default();
        for person in [vec![], vec![Var { name: "OPENCODE_DISABLE_PROJECT_CONFIG".into(), value: "0".into() }]] {
            let _ = std::fs::remove_file(&seen);
            let mine = Stored { path: prog.to_string_lossy().into_owned(), env: person, ..Stored::default() };
            // the stand-in lists no rules, so the chat itself is refused, after the listing ran with the chat's variables
            let refused = c.start_agent_mine("opencode", &dir, None, &[], None, false, &mine, |_| {});
            if refused.as_ref().is_err_and(|e| e.contains("env_")) {
                // a person's variable of that name is refused outright on Settings › Providers: nothing ran
                assert!(!seen.exists());
                continue;
            }
            assert!(refused.is_err());
            assert_eq!(seen_lines(&seen), ["OFF=1"]);
        }
        assert_eq!(c.count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A person's own agent turned off on Settings › Providers is refused before its entry is even resolved.
    #[test]
    fn a_turned_off_custom_or_acp_agent_starts_nothing() {
        let c = ChatSessions::default();
        let off = crate::providers::Stored { off: true, ..Default::default() };
        let tmp = std::env::temp_dir();
        for id in ["gemini", "cursor-agent", "agy", "opencode", "codex", "dsh"] {
            assert!(c.start_agent_mine(id, &tmp, None, &[], None, false, &off, |_| {}).unwrap_err().contains("turned off"), "{id}");
        }
        assert_eq!(c.count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_stand_in_agent_on_pipes_reaches_the_ui_and_close_kills_it() {
        let c = ChatSessions::default();
        let fx = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("claude-hi.jsonl");
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let mark = tmp.join(format!("manut-chat-stdin-{}", std::process::id()));
        // reads our initialize line (proves stdin works), prints the recorded stream, then hangs
        let script = format!("read l; printf '%s\\n' \"$l\" > '{}'; cat '{}'; trap '' HUP; while :; do sleep 1; done", mark.display(), fx.display());
        let (out, sink) = collect();
        let mut adapter: Box<dyn Adapter> = Box::new(Claude::default());
        adapter.on_input(Input::send("say hi")).unwrap();
        let id = c.spawn(vec!["/bin/sh".into(), "-c".into(), script.into()], &tmp, None, &[], adapter, sink).unwrap();
        assert!(wait_for(|| out.lock().unwrap().iter().any(|o| matches!(o, ChatOut::Event(e) if s(e, "event") == "turn.end")), 10));
        let first = std::fs::read_to_string(&mark).unwrap();
        assert!(first.contains("\"initialize\""), "{first}");
        let msgs: Vec<String> = out.lock().unwrap().iter().filter_map(|o| match o { ChatOut::Event(e) if s(e, "event") == "message" => Some(s(e, "text")), _ => None }).collect();
        assert_eq!(msgs, ["Hi. Ready when you are."]);
        // input goes through the adapter to the program
        c.input(id, Input::Interrupt).unwrap();
        assert!(c.input(id, Input::Approve { request_id: "nope".into(), choice: "once".into() }).is_err());
        c.close(id);
        assert_eq!(c.count(), 0);
        assert!(wait_for(|| out.lock().unwrap().iter().any(|o| matches!(o, ChatOut::Exit(..))), 10), "close did not stop a HUP-ignoring agent");
        assert!(c.input(id, Input::Interrupt).is_err());
        let _ = std::fs::remove_file(mark);
    }

    /// A custom agent (Settings › Agents) starts as exactly its program and its stored arguments, through no shell:
    /// a stub program records the argv it got and the first line manut wrote (the ACP `initialize`, with files and
    /// terminal off); a conversation id goes only into the protocol, and anything else is refused before a process.
    #[cfg(unix)]
    #[test]
    fn a_custom_agent_runs_exactly_its_program_and_arguments_with_no_shell() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().canonicalize().unwrap().join(format!("manut-custom-start-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        let rec = dir.join("argv.txt");
        let first = dir.join("stdin.txt");
        let stub = dir.join("bin").join("stub-agent");
        std::fs::write(&stub, format!("#!/bin/sh\nfor a in \"$0\" \"$@\"; do printf '%s\\n' \"$a\"; done > '{}'\nread l; printf '%s\\n' \"$l\" > '{}'\nexit 0\n", rec.display(), first.display())).unwrap();
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        let c = crate::custom_agents::CustomAgent { id: "stub".into(), label: "Stub".into(), program: "stub-agent".into(), args: vec!["acp".into(), "--model=x:y".into(), "a/b=c".into()], install: String::new() };
        let chats = ChatSessions::default();
        let (out, sink) = collect();
        chats.start_custom(&c, &[dir.join("bin")], &dir, None, &[], sink).unwrap();
        assert!(wait_for(|| out.lock().unwrap().iter().any(|o| matches!(o, ChatOut::Exit(..))), 10));
        let argv: Vec<String> = std::fs::read_to_string(&rec).unwrap().lines().map(String::from).collect();
        assert_eq!(argv, [stub.to_string_lossy().as_ref(), "acp", "--model=x:y", "a/b=c"]);
        let init: Value = serde_json::from_str(std::fs::read_to_string(&first).unwrap().trim()).unwrap();
        assert_eq!(init["method"], "initialize");
        assert_eq!(init["params"]["clientCapabilities"], json!({"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false}));
        // a conversation continues inside the protocol only: a checked id is accepted, anything else refused first
        let (_o, sink) = collect();
        assert_eq!(chats.start_custom(&c, &[dir.join("bin")], &dir, Some("ses 1; rm"), &[], sink).unwrap_err(), "not a conversation id");
        // not found on the folders given: refused, nothing runs
        let (_o, sink) = collect();
        assert!(chats.start_custom(&c, &[dir.join("nowhere")], &dir, None, &[], sink).unwrap_err().contains("not installed"));
        // an entry that fails a check never starts, even handed in directly
        let bad = crate::custom_agents::CustomAgent { args: vec!["-c".into(), "touch x".into()], ..c.clone() };
        let (_o, sink) = collect();
        assert!(chats.start_custom(&bad, &[dir.join("bin")], &dir, None, &[], sink).is_err());
        // a custom id the file does not hold is an unknown agent
        assert_eq!(chats.start_agent("stub-not-there", &dir, None, &[], None, |_| {}).unwrap_err(), "unknown agent \"stub-not-there\"");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn an_agent_that_dies_mid_turn_ends_the_turn_with_its_stderr() {
        let c = ChatSessions::default();
        let (out, sink) = collect();
        let mut adapter: Box<dyn Adapter> = Box::new(Claude::default());
        adapter.on_input(Input::send("x")).unwrap();
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        c.spawn(vec!["/bin/sh".into(), "-c".into(), "echo 'Error: not logged in' >&2; exit 2".into()], &tmp, None, &[], adapter, sink).unwrap();
        assert!(wait_for(|| out.lock().unwrap().iter().any(|o| matches!(o, ChatOut::Exit(..))), 10));
        let got = out.lock().unwrap().clone();
        assert!(got.iter().any(|o| matches!(o, ChatOut::Event(e) if s(e, "event") == "turn.end" && s(e, "error").contains("not logged in"))), "{got:?}");
        assert!(got.iter().any(|o| matches!(o, ChatOut::Exit(Some(2), e) if e.contains("not logged in"))), "{got:?}");
    }

    #[cfg(unix)]
    #[test]
    fn an_agent_that_exits_cleanly_mid_turn_ends_the_turn_and_reports_code_0() {
        let c = ChatSessions::default();
        let (out, sink) = collect();
        let mut adapter: Box<dyn Adapter> = Box::new(Claude::default());
        adapter.on_input(Input::send("x")).unwrap();
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        c.spawn(vec!["/bin/sh".into(), "-c".into(), "exit 0".into()], &tmp, None, &[], adapter, sink).unwrap();
        assert!(wait_for(|| out.lock().unwrap().iter().any(|o| matches!(o, ChatOut::Exit(..))), 10));
        let got = out.lock().unwrap().clone();
        assert!(got.iter().any(|o| matches!(o, ChatOut::Event(e) if s(e, "event") == "turn.end" && s(e, "outcome") == "ended")), "{got:?}");
        assert!(got.iter().any(|o| matches!(o, ChatOut::Exit(Some(0), e) if e.is_empty())), "{got:?}");
    }

    /// A temp home whose `active.json` picks `active` for claude, with that account's folder made.
    fn home_with_claude(name: &str, active: &str) -> std::path::PathBuf {
        let home = std::env::temp_dir().join(format!("manut-chat-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let root = home.join(".manut").join("accounts");
        std::fs::create_dir_all(root.join("claude").join("work")).unwrap();
        std::fs::write(root.join("active.json"), format!(r#"{{"claude":"{active}"}}"#)).unwrap();
        home
    }

    #[test]
    fn a_claude_chat_carries_the_stacked_account_home_and_this_computer_carries_none() {
        let cwd = std::env::temp_dir();
        // the argv chat_start builds for claude: the program, then the allow-list's chat arguments
        let argv: Vec<OsString> = std::iter::once(OsString::from("/x/claude")).chain(chat_args("claude").unwrap().iter().map(OsString::from)).collect();
        let envs = |cmd: &Command| -> Vec<(String, String)> {
            cmd.get_envs().filter_map(|(k, v)| Some((k.to_string_lossy().into_owned(), v?.to_string_lossy().into_owned()))).collect()
        };
        let base = envs(&command_for(&argv, &cwd, None, &[]).unwrap());

        let home = home_with_claude("stacked", "work");
        let cmd = command_for(&argv, &cwd, None, &crate::accounts::session_env(&home, "claude")).unwrap();
        let work = home.join(".manut").join("accounts").join("claude").join("work");
        assert_eq!(cmd.get_args().collect::<Vec<_>>(), argv[1..].iter().map(|a| a.as_os_str()).collect::<Vec<_>>(), "the account changes no argument");
        // the chosen account's home is the only thing added
        let added: Vec<_> = envs(&cmd).into_iter().filter(|p| !base.contains(p)).collect();
        assert_eq!(added, vec![("CLAUDE_CONFIG_DIR".to_string(), work.to_string_lossy().into_owned())]);

        let mine = home_with_claude("this-computer", "default");
        let cmd = command_for(&argv, &cwd, None, &crate::accounts::session_env(&mine, "claude")).unwrap();
        assert_eq!(envs(&cmd), base);
        assert!(!envs(&cmd).iter().any(|(k, _)| k == "CLAUDE_CONFIG_DIR"));
        let _ = (std::fs::remove_dir_all(home), std::fs::remove_dir_all(mine));
    }

    #[cfg(unix)]
    #[test]
    fn the_account_home_reaches_the_chat_program() {
        let home = home_with_claude("pipes", "work");
        let c = ChatSessions::default();
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let mark = tmp.join(format!("manut-chat-env-{}", std::process::id()));
        let script = format!("echo \"cfg=${{CLAUDE_CONFIG_DIR-unset}}\" > '{}'", mark.display());
        let (out, sink) = collect();
        c.spawn(vec!["/bin/sh".into(), "-c".into(), script.into()], &tmp, None, &crate::accounts::session_env(&home, "claude"), Box::new(Pi::default()), sink)
            .unwrap();
        assert!(wait_for(|| out.lock().unwrap().iter().any(|o| matches!(o, ChatOut::Exit(..))), 10));
        let work = home.join(".manut").join("accounts").join("claude").join("work");
        assert_eq!(std::fs::read_to_string(&mark).unwrap().trim(), format!("cfg={}", work.display()));
        let _ = (std::fs::remove_file(mark), std::fs::remove_dir_all(home));
    }

    /// Kit's dial reads a command from the session's folder, so Claude Code's shell must start every command there: a
    /// `cd` in one command must not carry to the next (item 116). A variable of the person's with the same name never wins.
    #[cfg(unix)]
    #[test]
    fn a_claude_chat_program_starts_every_command_in_the_session_folder() {
        let c = ChatSessions::default();
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let mark = tmp.join(format!("manut-chat-cwd-{}", std::process::id()));
        let script = format!("echo \"keep=${{CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR-unset}}\" > '{}'", mark.display());
        let mine = crate::providers::Stored { env: vec![crate::providers::Var { name: "CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR".into(), value: "0".into() }], ..Default::default() };
        let (out, sink) = collect();
        c.spawn(vec!["/bin/sh".into(), "-c".into(), script.into()], &tmp, None, &crate::providers::session_env("claude", &mine, &[], true), Box::new(Pi::default()), sink).unwrap();
        assert!(wait_for(|| out.lock().unwrap().iter().any(|o| matches!(o, ChatOut::Exit(..))), 10));
        assert_eq!(std::fs::read_to_string(&mark).unwrap().trim(), "keep=1");
        let _ = std::fs::remove_file(mark);
    }

    #[cfg(unix)]
    #[test]
    fn roots_name_each_running_chat_with_its_program_and_folder_and_drop_one_that_ended_or_was_closed() {
        let c = ChatSessions::default();
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let (_out, sink) = collect();
        let running = c.spawn(vec!["/bin/sh".into(), "-c".into(), "trap '' HUP; sleep 69".into()], &tmp, None, &[], Box::new(Pi::default()), sink).unwrap();
        let (ended_out, ended_sink) = collect();
        c.spawn(vec!["/bin/sh".into(), "-c".into(), "exit 0".into()], &tmp, None, &[], Box::new(Pi::default()), ended_sink).unwrap();
        assert!(wait_for(|| ended_out.lock().unwrap().iter().any(|o| matches!(o, ChatOut::Exit(..))), 10));
        // the one that ended is not listed: its number may be someone else's by now
        let roots = c.roots();
        assert_eq!(roots.len(), 1, "{roots:?}");
        let (id, pid, folder) = &roots[0];
        assert_eq!(*id, running);
        assert!(*pid > 1);
        assert_eq!(folder, &tmp);
        c.close(running);
        assert!(c.roots().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn close_all_stops_every_chat() {
        let c = ChatSessions::default();
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let (out, sink) = collect();
        c.spawn(vec!["/bin/sh".into(), "-c".into(), "trap '' HUP TERM; while :; do sleep 1; done".into()], &tmp, None, &[], Box::new(Pi::default()), sink).unwrap();
        c.close_all();
        assert_eq!(c.count(), 0);
        assert!(wait_for(|| out.lock().unwrap().iter().any(|o| matches!(o, ChatOut::Exit(..))), 10));
    }

    #[test]
    fn adjacent_deltas_merge_and_nothing_else_does() {
        let d = |t: &str| ev("delta", json!({"text": t}));
        let got = merge_deltas(vec![d("a"), d("b"), ev("thinking", json!({})), d("c"), d("d"), ev("message", json!({"id": "m", "text": "abcd"}))]);
        assert_eq!(names(&got), ["delta", "thinking", "delta", "message"]);
        assert_eq!(text_of(&got, "delta"), ["ab", "cd"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_big_send_to_an_agent_that_never_reads_blocks_nothing() {
        let c = ChatSessions::default();
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let (stuck_out, stuck_sink) = collect();
        let stuck = c.spawn(vec!["/bin/sh".into(), "-c".into(), "sleep 60".into()], &tmp, None, &[], Box::new(Pi::default()), stuck_sink).unwrap();
        let (_, other_sink) = collect();
        let mark = tmp.join(format!("manut-chat-other-{}", std::process::id()));
        let script = format!("while read l; do printf '%s\\n' \"$l\" >> '{}'; done", mark.display());
        let other = c.spawn(vec!["/bin/sh".into(), "-c".into(), script.into()], &tmp, None, &[], Box::new(Pi::default()), other_sink).unwrap();
        // 1 MB of prompts: the pipe takes about 64 KB, the rest must not hold anything up
        let started = Instant::now();
        for _ in 0..16 {
            c.input(stuck, Input::send("x".repeat(64 * 1024))).unwrap();
        }
        // A blocked send waits on a reader that sleeps for 60 s, so any bound well short of that catches it. 500 ms
        // failed at 560-860 ms on a host at load ~100 (sixteen 64 KiB prompts are framed in a debug build), so the
        // bound leaves room for a loaded machine without hiding a real block.
        assert!(started.elapsed() < Duration::from_secs(5), "input blocked: {:?}", started.elapsed());
        // other chats keep working while that one is stuck
        c.input(other, Input::send("pong")).unwrap();
        assert!(wait_for(|| std::fs::read_to_string(&mark).is_ok_and(|t| t.contains("pong")), 10), "other chat stalled");
        let t = Instant::now();
        c.close_all();
        assert!(t.elapsed() < Duration::from_secs(3), "close_all took {:?}", t.elapsed());
        assert_eq!(c.count(), 0);
        assert!(wait_for(|| stuck_out.lock().unwrap().iter().any(|o| matches!(o, ChatOut::Exit(..))), 10), "the stuck agent survived close_all");
        let _ = std::fs::remove_file(mark);
    }

    #[cfg(unix)]
    #[test]
    fn a_fast_token_stream_arrives_in_few_messages_and_split_lines_survive() {
        let c = ChatSessions::default();
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let (out, sink) = collect();
        let line = r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"x"}}"#;
        // 2000 one-token lines, then one line written in two halves 100 ms apart, then a last line with no LF
        let script = format!(
            "i=0; while [ $i -lt 2000 ]; do printf '%s\\n' '{line}'; i=$((i+1)); done; printf '%s' '{{\"type\":\"message_update\",'; sleep 0.1; printf '%s\\n' '\"assistantMessageEvent\":{{\"type\":\"text_delta\",\"delta\":\"ab\"}}}}'; printf '%s' '{{\"type\":\"message_update\",\"assistantMessageEvent\":{{\"type\":\"text_delta\",\"delta\":\"z\"}}}}'"
        );
        c.spawn(vec!["/bin/sh".into(), "-c".into(), script.into()], &tmp, None, &[], Box::new(Pi::default()), sink).unwrap();
        assert!(wait_for(|| out.lock().unwrap().iter().any(|o| matches!(o, ChatOut::Exit(..))), 20));
        let got = out.lock().unwrap();
        let deltas: Vec<String> = got.iter().filter_map(|o| match o { ChatOut::Event(e) if s(e, "event") == "delta" => Some(s(e, "text")), _ => None }).collect();
        let text = deltas.concat();
        assert_eq!(text, format!("{}abz", "x".repeat(2000)));
        // one event per line would be 2002
        assert!(deltas.len() < 200, "{} delta events", deltas.len());
    }

    /// The real OmO through `start_agent` (`omo --mode rpc`): "hi" gets an answer, then a second process started
    /// with the session id it reported (`--session`) still knows the first turn. Needs omo signed in.
    #[test]
    #[ignore]
    fn real_omo_chat_says_hi_and_resumes() {
        let dir = std::env::temp_dir().join(format!("manut-real-omo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let turn = |resume: Option<&str>, text: &str| -> (String, Vec<String>) {
            let c = ChatSessions::default();
            let out = Arc::new(Mutex::new(Vec::new()));
            let o = out.clone();
            let id = c.start_agent("omo", &dir, resume, &[], None, move |x| o.lock().unwrap().push(x)).unwrap();
            c.input(id, Input::send(text)).unwrap();
            let deadline = Instant::now() + Duration::from_secs(150);
            while Instant::now() < deadline && !out.lock().unwrap().iter().any(|x| matches!(x, ChatOut::Event(e) if s(e, "event") == "turn.end")) {
                thread::sleep(Duration::from_millis(100));
            }
            let got = out.lock().unwrap().clone();
            c.close(id);
            thread::sleep(Duration::from_millis(500));
            let session = got.iter().find_map(|x| match x { ChatOut::Event(e) if s(e, "event") == "session.info" && !s(e, "agent_session").is_empty() => Some(s(e, "agent_session")), _ => None }).unwrap_or_default();
            let msgs: Vec<String> = got.iter().filter_map(|x| match x { ChatOut::Event(e) if s(e, "event") == "message" => Some(s(e, "text")), _ => None }).collect();
            println!("omo session {session} (resume {resume:?}): {msgs:?}");
            (session, msgs)
        };
        let (session, first) = turn(None, "hi. reply with just the word pineapple");
        assert!(is_uuid(&session), "{session:?}");
        assert!(first.iter().any(|m| m.to_lowercase().contains("pineapple")), "{first:?}");
        let (again, second) = turn(Some(&session), "which fruit word did you just reply with? one word");
        assert_eq!(again, session);
        assert!(second.iter().any(|m| m.to_lowercase().contains("pineapple")), "{second:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The real OmO, Claude Code and Codex, one short message each through `start_agent`: every event the chat
    /// gets (and the ones that come within 4 s after the answer) leaves no turn open and says nothing outside one.
    /// `MANUT_REAL_OUT=<dir>` keeps each agent's events as `<agent>.json` for a replay through the store.
    /// Spends one small turn per agent: `cargo test real_agents_answer_and_go_idle -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_agents_answer_and_go_idle() {
        let dir = std::env::temp_dir().join(format!("manut-real-idle-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        for agent in ["omo", "claude", "codex"] {
            let c = ChatSessions::default();
            let out = Arc::new(Mutex::new(Vec::new()));
            let o = out.clone();
            let id = c.start_agent(agent, &dir, None, &[], None, move |x| o.lock().unwrap().push(x)).unwrap();
            if agent == "omo" {
                // OmO's own default can be a model its provider refuses on this machine: pick one it serves
                thread::sleep(Duration::from_secs(3));
                c.input(id, Input::Model { model: std::env::var("MANUT_REAL_OMO_MODEL").unwrap_or("anthropic/claude-fable-5-1".into()) }).unwrap();
                thread::sleep(Duration::from_secs(1));
            }
            c.input(id, Input::Send { text: "hi. reply with just the word ok".into(), images: vec![], id: String::new() }).unwrap();
            let deadline = Instant::now() + Duration::from_secs(150);
            while Instant::now() < deadline && !out.lock().unwrap().iter().any(|x| matches!(x, ChatOut::Event(e) if s(e, "event") == "turn.end")) {
                thread::sleep(Duration::from_millis(100));
            }
            // what the agent says after its turn (OmO's setStatus, agent_settled, …)
            thread::sleep(Duration::from_secs(4));
            let events: Vec<Event> = out.lock().unwrap().iter().filter_map(|x| match x { ChatOut::Event(e) => Some(e.clone()), _ => None }).collect();
            c.close(id);
            thread::sleep(Duration::from_millis(500));
            let mut open = false;
            for e in &events {
                match s(e, "event").as_str() {
                    "turn.start" => open = true,
                    "turn.end" => open = false,
                    "status" | "thinking" | "tool.start" | "tool.end" | "delta" | "skill" => assert!(open, "{agent}: {e} outside a turn"),
                    _ => {}
                }
            }
            let msgs: Vec<String> = events.iter().filter(|e| s(e, "event") == "message").map(|e| s(e, "text")).collect();
            let after = events.iter().skip_while(|e| s(e, "event") != "turn.end").skip(1).map(|e| s(e, "event")).collect::<Vec<_>>();
            println!("{agent}: answer {msgs:?}; {} events; after turn.end: {after:?}", events.len());
            assert!(!open, "{agent}: the turn never ended");
            assert!(msgs.iter().any(|m| m.to_lowercase().contains("ok")), "{agent}: {events:?}");
            if let Some(d) = std::env::var_os("MANUT_REAL_OUT") {
                std::fs::write(Path::new(&d).join(format!("{agent}.json")), serde_json::to_string_pretty(&events).unwrap()).unwrap();
            }
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The real attach check: a picture with a word in it and a small text file, saved and resolved exactly as a
    /// SESSIONS chat does (`session_files::save`, `Input::resolve`, the adapter's own image input; the text file
    /// named by its saved path), sent to the real agent in a temp folder. Approvals are answered `once`. Needs the
    /// agent installed and signed in: `MANUT_REAL_AGENT=codex cargo test real_agent_reads_attached_files --
    /// --ignored --nocapture` (claude, codex or omo; default claude).
    #[test]
    #[ignore]
    fn real_agent_reads_attached_files() {
        let agent = std::env::var("MANUT_REAL_AGENT").unwrap_or_else(|_| "claude".into());
        let base = std::env::temp_dir().join(format!("manut-real-attach-{agent}-{}", std::process::id()));
        let (home, dir) = (base.join("home"), base.join("proj"));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let (home, dir) = (home.canonicalize().unwrap(), dir.canonicalize().unwrap());
        let png = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/real/word.png")).unwrap();
        let pic = session_files::save(&home, "s1", "word.png", &png).unwrap();
        let txt = session_files::save(&home, "s1", "notes.txt", b"alpha line\nthe second line is cobalt-42\ngamma line\n").unwrap();
        // what the UI sends (attach.ts wireText): the typed text, then the non-picture file by its saved path
        let text = format!(
            "1) What word is written in the attached picture? 2) What is the second line of the attached text file? Answer as: picture=<word>; line2=<line>\n\nAttached file (a copy Manut AI saved; open it with your tools):\n- {}",
            txt.display()
        );
        let mut input = Input::Send { text, images: vec![Picture::from(pic.to_string_lossy().into_owned())], id: String::new() };
        input.resolve(&home).unwrap();
        let c = Arc::new(ChatSessions::default());
        let out = Arc::new(Mutex::new(Vec::<ChatOut>::new()));
        let (o, c2, me) = (out.clone(), c.clone(), Arc::new(Mutex::new(0u32)));
        let me2 = me.clone();
        let id = c
            .start_agent(&agent, &dir, None, &[], None, move |x| {
                if let ChatOut::Event(e) = &x {
                    if s(e, "event") == "approval.request" {
                        println!("approval {} {}", s(e, "title"), s(e, "command"));
                        let (c3, rid, id) = (c2.clone(), s(e, "request_id"), *me2.lock().unwrap());
                        thread::spawn(move || {
                            let _ = c3.input(id, Input::Approve { request_id: rid, choice: "once".into() });
                        });
                    }
                }
                o.lock().unwrap().push(x);
            })
            .unwrap();
        *me.lock().unwrap() = id;
        c.input(id, input).unwrap();
        let deadline = Instant::now() + Duration::from_secs(240);
        while Instant::now() < deadline && !out.lock().unwrap().iter().any(|x| matches!(x, ChatOut::Event(e) if s(e, "event") == "turn.end")) {
            thread::sleep(Duration::from_millis(100));
        }
        let got = out.lock().unwrap().clone();
        let msgs: Vec<String> = got.iter().filter_map(|x| match x { ChatOut::Event(e) if s(e, "event") == "message" => Some(s(e, "text")), _ => None }).collect();
        println!("{agent} answered: {msgs:?}");
        c.close(id);
        thread::sleep(Duration::from_millis(500));
        let all = msgs.join(" ").to_lowercase();
        let _ = std::fs::remove_dir_all(&base);
        assert!(all.contains("marigold") && all.contains("cobalt-42"), "{got:?}");
    }

    /// The real check for a session's transcript: the agent (MANUT_REAL_AGENT, default claude) in a temp folder through
    /// manut's own start, asked for a two-file edit with its todo list; prints what the chat got (each edit's change,
    /// the todo list, the thinking text), then takes the message back with the agent's own rewind and asks whether it
    /// remembers it. Approvals for files inside the folder are answered `once`. Spends two short turns:
    /// `cargo test real_agent_shows_its_work -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_agent_shows_its_work() {
        let agent = std::env::var("MANUT_REAL_AGENT").unwrap_or_else(|_| "claude".into());
        let base = std::env::var("MANUT_REAL_DIR").map(std::path::PathBuf::from).unwrap_or_else(|_| std::env::temp_dir().join(format!("manut-real-work-{agent}-{}", std::process::id())));
        let dir = base.join("proj");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("calc.py"), "def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n").unwrap();
        std::fs::write(dir.join("README.md"), "# calc\n\nTiny math helpers.\n").unwrap();
        let dir = dir.canonicalize().unwrap();
        let c = Arc::new(ChatSessions::default());
        let out = Arc::new(Mutex::new(Vec::<ChatOut>::new()));
        let (o, c2, me) = (out.clone(), c.clone(), Arc::new(Mutex::new(0u32)));
        let me2 = me.clone();
        let inside = dir.to_string_lossy().into_owned();
        let id = c
            .start_agent(&agent, &dir, None, &[], None, move |x| {
                if let ChatOut::Event(e) = &x {
                    if s(e, "event") == "approval.request" {
                        let ok = s(e, "title").contains("calc.py") || s(e, "title").contains("README.md") || s(e, "command").contains(&inside);
                        let (c3, rid, id) = (c2.clone(), s(e, "request_id"), *me2.lock().unwrap());
                        thread::spawn(move || {
                            let _ = c3.input(id, Input::Approve { request_id: rid, choice: if ok { "once".into() } else { "deny".into() } });
                        });
                    }
                }
                o.lock().unwrap().push(x);
            })
            .unwrap();
        *me.lock().unwrap() = id;
        let ends = |out: &Arc<Mutex<Vec<ChatOut>>>| out.lock().unwrap().iter().filter(|x| matches!(x, ChatOut::Event(e) if s(e, "event") == "turn.end")).count();
        let wait = |n: usize| {
            let deadline = Instant::now() + Duration::from_secs(300);
            while Instant::now() < deadline && ends(&out) < n {
                thread::sleep(Duration::from_millis(200));
            }
        };
        let text = "Make a 3-item todo list with your task tools first, then do it, updating each item as you go: in calc.py add a mul(a, b) function and give add a one-line docstring; in README.md add a line listing the functions. Think briefly first.";
        c.input(id, Input::Send { text: text.into(), images: vec![], id: "local-1".into() }).unwrap();
        wait(1);
        thread::sleep(Duration::from_millis(500));
        // the rewind, then a question about the message it took back
        let r = c.input(id, Input::Rewind);
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline && !out.lock().unwrap().iter().any(|x| matches!(x, ChatOut::Event(e) if s(e, "event") == "rewound" || s(e, "event") == "session.error")) {
            thread::sleep(Duration::from_millis(200));
        }
        c.input(id, Input::Send { text: "Did I ask you for anything earlier in this conversation? Answer yes or no, then say what in five words.".into(), images: vec![], id: "local-2".into() }).unwrap();
        wait(2);
        let got: Vec<Value> = out.lock().unwrap().iter().filter_map(|x| match x { ChatOut::Event(e) => Some(e.clone()), _ => None }).collect();
        c.close(id);
        let dump = base.join("events.jsonl");
        std::fs::write(&dump, got.iter().map(|e| e.to_string() + "\n").collect::<String>()).unwrap();
        println!("rewind input: {r:?}; events: {}", dump.display());
        for e in &got {
            match s(e, "event").as_str() {
                "tool.diff" => println!("DIFF {}", e["files"]),
                "plan" => println!("PLAN {}", e["items"]),
                "rewound" | "message" | "turn.end" | "session.error" => println!("{e}"),
                _ => {}
            }
        }
        let thinking: String = got.iter().filter(|e| s(e, "event") == "thinking").map(|e| s(e, "text")).collect();
        println!("THINKING {thinking:?}");
        assert!(got.iter().any(|e| s(e, "event") == "tool.diff"), "no diff");
    }

    /// The real check: Claude Code in its chat mode in a temp folder, "reply with the word ok", through the
    /// same allow-list, adapter and pipes a session uses. Needs claude installed and signed in, and spends a
    /// tiny turn: `cargo test real_claude_chat_replies_ok -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_claude_chat_replies_ok() {
        let c = ChatSessions::default();
        let dir = std::env::temp_dir().join(format!("manut-real-chat-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = Arc::new(Mutex::new(Vec::new()));
        let o = out.clone();
        let id = c
            .start_agent("claude", &dir.canonicalize().unwrap(), None, &[], None, move |x| {
                if let ChatOut::Event(e) = &x {
                    if s(e, "event") != "session.models" {
                        println!("event {e}");
                    }
                } else {
                    println!("{x:?}");
                }
                o.lock().unwrap().push(x);
            })
            .unwrap();
        c.input(id, Input::send("reply with the word ok")).unwrap();
        let deadline = Instant::now() + Duration::from_secs(120);
        while Instant::now() < deadline && !out.lock().unwrap().iter().any(|x| matches!(x, ChatOut::Event(e) if s(e, "event") == "turn.end")) {
            thread::sleep(Duration::from_millis(100));
        }
        let got = out.lock().unwrap().clone();
        let msg: Vec<String> = got.iter().filter_map(|x| match x { ChatOut::Event(e) if s(e, "event") == "message" => Some(s(e, "text")), _ => None }).collect();
        println!("bubble: {msg:?}");
        assert!(msg.iter().any(|m| m.to_lowercase().contains("ok")), "{got:?}");
        c.close(id);
        thread::sleep(Duration::from_millis(500));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn real_claude_4_stop_mid_command_withdraws_the_card_and_ends_interrupted() {
        let mut c = claude_up();
        let lines = real("claude-4-stop.jsonl");
        // the recording first finishes the resume turn, then the person asks for a slow command
        let second = lines.iter().rposition(|l| l.contains("\"subtype\":\"init\"")).unwrap();
        c.on_input(Input::send("which file")).unwrap();
        run(&mut c, &lines[..second]);
        c.on_input(Input::send("sleep")).unwrap();
        let st = run(&mut c, &lines[second..]);
        let card = of(&st.events, "approval.request")[0].clone();
        assert!(s(&card, "command").starts_with("python3 -c"), "{card}");
        // Stop while the card is open: Claude Code withdraws it (control_cancel_request), the card closes
        let stop = written(&c.on_input(Input::Interrupt).unwrap())[0].clone();
        assert_eq!(stop["request"]["subtype"], "interrupt");
        let rest = run(&mut c, &real("claude-4-stopped.jsonl"));
        assert_eq!(of(&rest.events, "prompt.expired")[0]["request_id"], card["request_id"]);
        assert_eq!(ends(&rest.events), [("interrupted".into(), "".into())]);
        assert!(!c.in_turn());
        // the next message starts a new turn
        assert_eq!(names(&c.on_input(Input::send("again")).unwrap().events), ["turn.start"]);
    }

    /// H4: the QA's `old-omo` stub (an old OmO that ignores `--mode rpc`, draws its terminal UI and waits). The start
    /// deadline ends the session with the plain reason, the message sent meanwhile ends with it, nothing stays
    /// Working, and the program (and what it started) is stopped.
    #[cfg(unix)]
    #[test]
    fn a_program_that_never_answers_in_chat_mode_ends_with_the_reason() {
        let mut c = ChatSessions::default();
        c.start_deadline = Some(Duration::from_millis(600));
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let (out, sink) = collect();
        let script = "trap '' HUP; printf '\\033[?1049h\\033[2J omo 3.0 interactive  (press q)\\n'; sleep 30 & cat >/dev/null; wait";
        let id = c.spawn(vec!["/bin/sh".into(), "-c".into(), script.into()], &tmp, None, &[], Box::new(Pi::new("/w", "OmO")), sink).unwrap();
        c.input(id, Input::send("hi")).unwrap();
        let started = Instant::now();
        assert!(wait_for(|| out.lock().unwrap().iter().any(|o| matches!(o, ChatOut::Exit(..))), 10), "still Working");
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
        let got = out.lock().unwrap().clone();
        let why = "OmO did not answer in chat mode; it may be an old version: update it, then Restart.";
        assert!(got.iter().any(|o| matches!(o, ChatOut::Event(e) if s(e, "event") == "session.error" && s(e, "kind") == "no_chat_mode" && s(e, "message") == why)), "{got:?}");
        assert!(got.iter().any(|o| matches!(o, ChatOut::Event(e) if s(e, "event") == "turn.end" && s(e, "outcome") == "error" && s(e, "error") == why)), "{got:?}");
        assert!(got.iter().any(|o| matches!(o, ChatOut::Exit(_, e) if e == why)), "{got:?}");
    }

    /// H4: a slow but healthy start is not cut: an agent whose first protocol line comes after a while (within the
    /// deadline) keeps its session and answers.
    #[cfg(unix)]
    #[test]
    fn a_slow_start_within_the_deadline_still_works() {
        let mut c = ChatSessions::default();
        c.start_deadline = Some(Duration::from_millis(1500));
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let (out, sink) = collect();
        let script = r#"sleep 0.8; printf '{"id":"manut-1","type":"response","command":"get_state","success":true,"data":{"model":{"name":"M"},"sessionId":"slow"}}\n'; sleep 1.5; printf '{"type":"agent_start"}\n{"type":"agent_end"}\n'; sleep 0.2"#;
        let mut a: Box<dyn Adapter> = Box::new(Pi::new("/w", "pi"));
        a.on_input(Input::send("hi")).unwrap();
        c.spawn(vec!["/bin/sh".into(), "-c".into(), script.into()], &tmp, None, &[], a, sink).unwrap();
        assert!(wait_for(|| out.lock().unwrap().iter().any(|o| matches!(o, ChatOut::Exit(..))), 10));
        let got = out.lock().unwrap().clone();
        assert!(!got.iter().any(|o| matches!(o, ChatOut::Event(e) if s(e, "kind") == "no_chat_mode")), "{got:?}");
        assert!(got.iter().any(|o| matches!(o, ChatOut::Event(e) if s(e, "event") == "turn.end" && s(e, "outcome") == "done")), "{got:?}");
        assert!(got.iter().any(|o| matches!(o, ChatOut::Exit(Some(0), e) if e.is_empty())), "{got:?}");
    }

    /// H4: the QA's `old-pi` stub (exits at once with `error: unknown option '--mode'`): the same plain reason, not
    /// the raw flag error.
    #[cfg(unix)]
    #[test]
    fn an_old_version_that_refuses_the_chat_mode_flag_says_so_plainly() {
        let c = ChatSessions::default();
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let (out, sink) = collect();
        let script = "echo \"error: unknown option '--mode'\" >&2; echo 'Usage: pi [options] [message]' >&2; exit 1";
        c.spawn(vec!["/bin/sh".into(), "-c".into(), script.into()], &tmp, None, &[], Box::new(Pi::new("/w", "pi")), sink).unwrap();
        assert!(wait_for(|| out.lock().unwrap().iter().any(|o| matches!(o, ChatOut::Exit(..))), 10));
        let got = out.lock().unwrap().clone();
        let why = "pi did not answer in chat mode; it may be an old version: update it, then Restart.";
        assert!(got.iter().any(|o| matches!(o, ChatOut::Event(e) if s(e, "kind") == "no_chat_mode")), "{got:?}");
        assert!(got.iter().any(|o| matches!(o, ChatOut::Exit(Some(1), e) if e == why)), "{got:?}");
        // a program that did speak its protocol keeps its own reason (a login, a crash)
        assert!(refused_chat_mode("error: unknown option '--mode'") && refused_chat_mode("error: unexpected argument 'app-server' found"));
        assert!(!refused_chat_mode("Error: not logged in"));
    }

    /// H12: closing a chat stops what its program started too (Unix: the process group; Windows: the Job Object
    /// that holds `cmd.exe` and the `node.exe` behind an npm shim). Here a child that ignores hang-up and outlives
    /// its parent stands in for node behind cmd.exe.
    #[cfg(unix)]
    #[test]
    fn closing_a_chat_stops_the_processes_its_program_started() {
        let c = ChatSessions::default();
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let mark = tmp.join(format!("manut-chat-tree-{}", std::process::id()));
        let (out, sink) = collect();
        // the grandchild writes its pid, ignores HUP and TERM, and lives on alone once the shell above it is gone
        let script = format!("sh -c 'trap \"\" HUP TERM; echo $$ > \"{}\"; while :; do sleep 1; done' & printf '{{\"type\":\"agent_start\"}}\\n'; wait", mark.display());
        let id = c.spawn(vec!["/bin/sh".into(), "-c".into(), script.into()], &tmp, None, &[], Box::new(Pi::new("/w", "pi")), sink).unwrap();
        assert!(wait_for(|| std::fs::read_to_string(&mark).is_ok_and(|t| !t.trim().is_empty()), 10));
        let pid: i32 = std::fs::read_to_string(&mark).unwrap().trim().parse().unwrap();
        c.close(id);
        assert!(wait_for(|| out.lock().unwrap().iter().any(|o| matches!(o, ChatOut::Exit(..))), 10));
        assert!(wait_for(|| unsafe { libc::kill(pid, 0) } != 0, 10), "pid {pid} kept running after close");
        let _ = std::fs::remove_file(mark);
    }

    /// H12 on Windows (runs on the Windows CI job only): a chat started through `cmd.exe /c` — as an npm `.cmd` shim
    /// is — whose child outlives cmd.exe; closing the chat ends that child too.
    #[cfg(windows)]
    #[test]
    fn closing_a_chat_stops_the_node_behind_a_cmd_shim() {
        let c = ChatSessions::default();
        let tmp = std::env::temp_dir();
        let mark = tmp.join(format!("manut-chat-tree-{}.txt", std::process::id()));
        let _ = std::fs::remove_file(&mark);
        let (out, sink) = {
            let out = Arc::new(Mutex::new(Vec::new()));
            let o = out.clone();
            (out, move |x| o.lock().unwrap().push(x))
        };
        // cmd.exe starts a PowerShell that writes its own pid and sleeps; cmd.exe itself waits on it, as on node
        let ps = format!("$PID | Out-File -Encoding ascii '{}'; Start-Sleep -Seconds 120", mark.display());
        let argv: Vec<OsString> = vec!["cmd.exe".into(), "/c".into(), "powershell".into(), "-NoProfile".into(), "-Command".into(), ps.into()];
        let id = c.spawn(argv, &tmp, None, &[], Box::new(Pi::new("/w", "pi")), sink).unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline && !std::fs::read_to_string(&mark).is_ok_and(|t| !t.trim().is_empty()) {
            thread::sleep(Duration::from_millis(100));
        }
        let pid: u32 = std::fs::read_to_string(&mark).unwrap().trim().parse().unwrap();
        c.close(id);
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline && !out.lock().unwrap().iter().any(|o| matches!(o, ChatOut::Exit(..))) {
            thread::sleep(Duration::from_millis(50));
        }
        let alive = || {
            let o = Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().unwrap();
            String::from_utf8_lossy(&o.stdout).contains(&pid.to_string())
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline && alive() {
            thread::sleep(Duration::from_millis(100));
        }
        assert!(!alive(), "the process behind cmd.exe (pid {pid}) kept running after close");
        let _ = std::fs::remove_file(mark);
    }

    #[test]
    fn codex_resume_takes_only_a_thread_uuid() {
        let c = ChatSessions::default();
        let tmp = std::env::temp_dir();
        for bad in ["x", "--yolo", "01a1c3b9-4b7f-7542-900c-c5f4dc80eef", "../01a1c3b9-4b7f-7542-900c-c5f4dc80eefa"] {
            assert!(c.start_agent("codex", &tmp, Some(bad), &[], None, |_| {}).is_err(), "{bad}");
        }
        assert!(c.start_agent("pi", &tmp, Some("01a1c3b9-4b7f-7542-900c-c5f4dc80eefa"), &[], None, |_| {}).is_err());
        assert_eq!(c.count(), 0);
    }

    #[test]
    fn claude_thinking_text_is_kept_and_a_marker_without_text_stays_empty() {
        // claude-12-thinking: Claude Code 2.1.322 (fable) streams its thinking as text deltas
        let mut c = claude_up();
        c.on_input(Input::send("go")).unwrap();
        let st = run(&mut c, &real("claude-12-thinking.jsonl"));
        let text: String = of_kind(&st.events, "thinking").iter().map(|e| s(e, "text")).collect();
        assert!(text.starts_with("No todo tool is available, so I'll track the three steps inline"), "{text}");
        // claude-3-edit: an older recording with the thinking text stripped; the events say only that it thinks
        let mut c = claude_up();
        c.on_input(Input::send("go")).unwrap();
        let st = run(&mut c, &real("claude-3-edit.jsonl"));
        let t = of_kind(&st.events, "thinking");
        assert!(!t.is_empty() && t.iter().all(|e| e.get("text").is_none()));
        // joined in delivery like answer text, never across kinds
        let got = merge_deltas(vec![thinking_event("a"), thinking_event("b"), ev("delta", json!({"text": "c"})), thinking_event("d")]);
        assert_eq!(got, vec![thinking_event("ab"), ev("delta", json!({"text": "c"})), thinking_event("d")]);
    }

    #[test]
    fn a_suggested_next_message_is_asked_for_only_of_claude_code_and_only_when_turned_on() {
        // item 76: Claude Code's own `--prompt-suggestions`; no other agent offers a way, so none is passed one
        assert_eq!(suggest_args("claude", true), ["--prompt-suggestions", "true"]);
        assert!(suggest_args("claude", false).is_empty());
        for other in ["codex", "pi", "omp", "omo", "opencode", "cursor", "dsh", "grok"] {
            assert!(suggest_args(other, true).is_empty(), "{other}");
        }
        // the fixed chat arguments are untouched: the setting adds, never replaces
        assert!(!chat_args("claude").unwrap().contains(&"--prompt-suggestions"));
    }
}
