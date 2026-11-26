//! The Codex adapter: `codex app-server`, JSON-RPC over stdio (`thread/start`, `turn/start`, `item/*`,
//! `item/commandExecution/requestApproval`, `turn/interrupt`). It turns Codex's threads, turns and items into the
//! events the chat already draws, and the person's input (text, Stop, approval answers, model) into Codex's own
//! requests, so no part of Codex's wire format is seen outside this file.

use super::*;
use super::subagents::{
    CHOICES,
    Sub,
    Subagents,
    answers_by_qid,
    clarify_event,
    codex_diff,
    command_end,
    edit_detail,
    lines_of,
    plan_event,
    rel,
    tag_asks,
    thinking_event,
    title_of,
    tool_detail,
    tool_kind,
    unified_counts,
    unwrap_shell,
    with_cwd,
};

// ---------------------------------------------------------------------------------------------
// Codex (app-server, JSON-RPC over stdio)
// ---------------------------------------------------------------------------------------------

enum CodexAsk {
    Command(Value),
    File(Value),
    /// `item/tool/requestUserInput`: JSON-RPC id and question ids
    Input(Value, Vec<String>),
    /// a question in an agent message (`questions`), answered by steering the turn
    Message,
}

pub struct Codex {
    cwd: String,
    resume: Option<String>,
    seq: u64,
    /// request id -> method, for matching responses
    calls: HashMap<u64, &'static str>,
    thread: Option<String>,
    turn_id: Option<String>,
    turn: bool,
    model: Option<String>,
    model_id: String,
    labels: HashMap<String, String>,
    queued: Vec<(String, Vec<Picture>, String)>,
    /// open approvals and questions by our request id
    pending: HashMap<String, CodexAsk>,
    /// the sub-agent thread that asked each pending request, when one did
    ask_helpers: HashMap<String, String>,
    /// diff summaries of fileChange items, shown on their approval card
    changes: HashMap<String, String>,
    /// every path of each fileChange item and whether it deletes a file (`ask_tool::codex_change`), named on its
    /// approval for Kit's dial; an item whose paths cannot all be read has none
    change_paths: HashMap<String, (Vec<String>, bool)>,
    /// the last error notification was a 401 (not signed in)
    unauthorized: bool,
    /// Stop was pressed before Codex named the turn: interrupt it as soon as it does
    stop_asked: bool,
    /// the person's mode (approval policy, sandbox) and effort, sent with every turn from the next one on
    mode: Option<(&'static str, &'static str)>,
    effort: Option<String>,
    /// effort levels per model, from model/list
    efforts: HashMap<String, Value>,
    /// skill name -> its SKILL.md path (skills/list), for `$name` in a message
    skills: HashMap<String, String>,
    waiting: Waiting,
    /// Codex's sub-agents by their own thread id. The app-server streams their threads on this connection; their
    /// events become `subagent` events and never touch the person's turn, its answer or its Stop.
    helpers: Subagents,
    /// the person's turns Codex named in this process, oldest first: a rewind reverts the thread to before the last
    turns: Vec<String>,
    /// the turn each of the person's messages went into, by its bubble id (Codex's `clientId`), oldest first: what a
    /// rewind to a turn names
    msg_turns: Vec<(String, String)>,
    /// where a rewind to a turn asked Codex to go back to (an index in `turns`), until it answers
    revert_to: Option<usize>,
    /// reasoning items that streamed a summary: their raw text is not shown as well
    summarized: std::collections::HashSet<String>,
    /// turn/steer request id -> the steered message's bubble id
    steers: HashMap<u64, String>,
}

const CODEX_SIGNED_OUT: &str = "Codex is not signed in. Sign in from Settings › Accounts (or run `codex login`), then Restart.";

impl Codex {
    pub fn new(cwd: &str, resume: Option<&str>) -> Codex {
        Codex {
            cwd: cwd.into(),
            resume: resume.map(String::from),
            seq: 0,
            calls: HashMap::new(),
            thread: None,
            turn_id: None,
            turn: false,
            model: None,
            model_id: String::new(),
            labels: HashMap::new(),
            queued: vec![],
            pending: HashMap::new(),
            ask_helpers: HashMap::new(),
            changes: HashMap::new(),
            change_paths: HashMap::new(),
            unauthorized: false,
            stop_asked: false,
            mode: None,
            effort: None,
            efforts: HashMap::new(),
            skills: HashMap::new(),
            waiting: Waiting::default(),
            helpers: Subagents::new("codex"),
            turns: Vec::new(),
            msg_turns: Vec::new(),
            revert_to: None,
            summarized: Default::default(),
            steers: HashMap::new(),
        }
    }
    /// This chat's thread starts (or continues) in `mode`, one of [`modes_for`]`("codex")`, and every turn carries it, so
    /// neither Codex's own configuration nor a project's `.codex/config.toml` chooses how it asks (item 89). Anything
    /// else leaves the adapter as it was; [`start_mode`] has already refused it.
    pub fn starting_in(mut self, mode: &str) -> Codex {
        if let Some(m) = codex_mode(mode) {
            self.mode = Some(m);
        }
        self
    }
    /// `thread/start` or `thread/resume` for this chat: `base`, and the mode in force as the thread's approval policy and
    /// sandbox (`ThreadStartParams`/`ThreadResumeParams` in `codex app-server generate-json-schema`, 0.169.0, which spell the
    /// sandbox `read-only` and `workspace-write` where a turn's `sandboxPolicy.type` says `readOnly` and `workspaceWrite`).
    fn thread_params(&self, mut base: Value) -> Value {
        if let Some((policy, sandbox)) = self.mode {
            let sandbox = match sandbox {
                "readOnly" => "read-only",
                "workspaceWrite" => "workspace-write",
                _ => return base,
            };
            base["approvalPolicy"] = Value::String(policy.into());
            base["sandbox"] = Value::String(sandbox.into());
        }
        base
    }
    fn call(&mut self, st: &mut Step, method: &'static str, params: Value) {
        self.seq += 1;
        self.calls.insert(self.seq, method);
        st.out(json!({"id": self.seq, "method": method, "params": params}));
    }
    fn turn_start(&mut self, st: &mut Step, text: String, images: &[Picture], id: &str) {
        let thread = self.thread.clone().unwrap_or_default();
        // pictures as app-server `localImage` items: Codex reads the saved copy itself
        let mut input: Vec<Value> = images.iter().map(|p| json!({"type": "localImage", "path": p.path})).collect();
        if !text.is_empty() || input.is_empty() {
            input.push(json!({"type": "text", "text": text}));
        }
        // a skill named as `$name` goes with it as Codex's own skill input, as its TUI sends it
        for w in text.split_whitespace() {
            if let Some(path) = w.strip_prefix('$').and_then(|n| self.skills.get(n).map(|p| (n, p))) {
                input.push(json!({"type": "skill", "name": path.0, "path": path.1}));
            }
        }
        let mut p = json!({"threadId": thread, "input": input});
        if let Some(m) = &self.model {
            p["model"] = Value::String(m.clone());
        }
        if let Some((policy, sandbox)) = self.mode {
            p["approvalPolicy"] = Value::String(policy.into());
            p["sandboxPolicy"] = json!({"type": sandbox});
        }
        if let Some(e) = &self.effort {
            p["effort"] = Value::String(e.clone());
        }
        if !id.is_empty() {
            p["clientUserMessageId"] = Value::String(id.into());
        }
        self.call(st, "turn/start", p);
    }
    /// The effort levels of `model`, as model/list gave them.
    fn efforts_event(&self, model: &str) -> Option<Event> {
        self.efforts.get(model).filter(|l| l.as_array().is_some_and(|a| !a.is_empty())).map(|l| ev("session.efforts", json!({"levels": l})))
    }
    fn label(&self, model: &str) -> String {
        self.labels.get(model).cloned().unwrap_or_else(|| model.to_string())
    }
    /// Codex named the running turn: a Stop pressed before that interrupts it now.
    fn named(&mut self, st: &mut Step, turn: &str) {
        self.turn_id = Some(turn.into());
        if self.turns.last().map(String::as_str) != Some(turn) {
            self.turns.push(turn.into());
            if self.turns.len() == 1 {
                st.emit(ev("session.info", json!({"rewind": true})));
            }
        }
        if std::mem::take(&mut self.stop_asked) && self.turn {
            let thread = self.thread.clone().unwrap_or_default();
            self.call(st, "turn/interrupt", json!({"threadId": thread, "turnId": turn}));
        }
    }
    fn end(&mut self, st: &mut Step, outcome: &str, error: Option<String>) {
        self.stop_asked = false;
        if self.turn {
            self.turn = false;
            self.turn_id = None;
            // approvals die with the turn, except a sub-agent's that still runs (its ask follows it, as Claude Code's
            // background subagents' do); a question asked in a message is answered with the next turn
            let open = self.helpers.open();
            let keep: Vec<String> = self.ask_helpers.iter().filter(|(_, t)| open.contains(t)).map(|(r, _)| r.clone()).collect();
            self.pending.retain(|r, a| matches!(a, CodexAsk::Message) || keep.contains(r));
            self.ask_helpers.retain(|r, _| keep.contains(r));
            let mut f = json!({"outcome": outcome});
            if let Some(e) = error.filter(|e| !e.is_empty()) {
                f["error"] = Value::String(e);
            }
            // a stopped turn's messages that Codex never recorded were not sent; a finished one took them
            if outcome == "interrupted" {
                self.waiting.all_dropped(st);
            } else {
                self.waiting.all_taken(st);
            }
            st.emit(ev("turn.end", f));
        }
    }
    /// The command an item runs, as the person would type it: Codex's command with its shell wrapper taken off. Codex's
    /// parsed actions describe a command and may name less than it runs (one read of a piped line), so a parsed action
    /// stands in only when Codex sends no command at all (item 117: an approval shows what runs).
    fn command_of(p: &Value) -> String {
        let raw = s(p, "command");
        let un = unwrap_shell(&raw);
        if !un.trim().is_empty() {
            return un;
        }
        match p.get("commandActions").and_then(Value::as_array) {
            Some(a) if a.len() == 1 && !s(&a[0], "command").is_empty() => s(&a[0], "command"),
            _ => raw,
        }
    }
    /// A sub-agent's thread: one Codex named as a sub-agent (`subAgentActivity`), or one whose turn belongs to
    /// another turn (`rootTurnId`). Any other thread id is the session's own.
    fn is_helper(&self, thread: &str) -> bool {
        self.helpers.has(thread)
    }
    /// A turn of another thread that belongs to a running turn (a sub-agent of a sub-agent, or one Codex did not
    /// announce): registered as a sub-agent.
    fn adopt(&mut self, thread: &str, method: &str, p: &Value) {
        if thread.is_empty() || self.is_helper(thread) || self.thread.as_deref() == Some(thread) || !method.starts_with("turn/") {
            return;
        }
        let t = &p["turn"];
        let root = s(t, "rootTurnId");
        if !root.is_empty() && root != s(t, "id") {
            self.helper(thread, "", "");
        }
    }
    /// The sub-agent of `thread`, registered on first sight in the fan-out of the person's running turn
    /// ("/root/read_first_line" -> "read first line"). Codex streams no task text for it: its goal stays empty.
    fn helper(&mut self, thread: &str, path: &str, model: &str) -> &mut Sub {
        let delegation = format!("codex-{}", self.turn_id.clone().unwrap_or_default());
        let name = path.rsplit('/').next().unwrap_or("").replace('_', " ");
        self.helpers.add(thread, &delegation, &name, "", model)
    }
    /// `subAgentActivity` (on the session's thread, or a sub-agent's for a nested one): one started or ended.
    fn helper_activity(&mut self, st: &mut Step, item: &Value, done: bool) {
        let thread = s(item, "agentThreadId");
        if thread.is_empty() || self.thread.as_deref() == Some(thread.as_str()) {
            return;
        }
        self.helper(&thread, &s(item, "agentPath"), &s(item, "model"));
        match (s(item, "kind").as_str(), done) {
            ("started", false) => st.events.extend(self.helpers.event(&thread, "running", json!({}))),
            // its thread's own turn/completed normally says so first, with its time
            ("completed", true) => self.helpers.end(st, &thread, "done", "", None),
            _ => {}
        }
    }
    /// A line of a sub-agent's own thread: its steps and its end. Its text is held as its answer, never shown as
    /// Codex's; its deltas, reasoning and warnings are dropped.
    fn on_helper_line(&mut self, st: &mut Step, thread: &str, method: &str, p: &Value) {
        let item = p.get("item").cloned().unwrap_or(Value::Null);
        match method {
            "item/started" => {
                if s(&item, "type") == "subAgentActivity" {
                    return self.helper_activity(st, &item, false);
                }
                if let Some((tool, step)) = self.item_step(&item) {
                    // its file change carries the patch, as the session's own does: the step opens to it
                    let files = if s(&item, "type") == "fileChange" { codex_diff(&item, &self.cwd) } else { vec![] };
                    if files.is_empty() {
                        self.helpers.step(st, thread, &tool, &step);
                    } else {
                        self.helpers.edit(st, thread, &step, files);
                    }
                }
            }
            "item/completed" => match s(&item, "type").as_str() {
                // what the change finally was (it may differ from what it asked)
                "fileChange" => {
                    let files = codex_diff(&item, &self.cwd);
                    if !files.is_empty() {
                        let step = self.file_changes(&item);
                        self.helpers.edit(st, thread, &step, files);
                    }
                }
                "agentMessage" => {
                    let t = s(&item, "text");
                    if !t.trim().is_empty() {
                        self.helper(thread, "", "").text = t;
                    }
                }
                "subAgentActivity" => self.helper_activity(st, &item, true),
                _ => {}
            },
            "turn/completed" => {
                let t = &p["turn"];
                let secs = t.get("durationMs").and_then(Value::as_u64).map(|ms| ms as f64 / 1000.0);
                match s(t, "status").as_str() {
                    "interrupted" => self.helpers.end(st, thread, "cancelled", "", secs),
                    "failed" => {
                        let e = t.get("error").map(|e| s(e, "message")).unwrap_or_default();
                        self.helpers.end(st, thread, "failed", if e.is_empty() { "failed" } else { &e }, secs)
                    }
                    _ => self.helpers.end(st, thread, "done", "", secs),
                }
            }
            _ => {}
        }
    }
    /// The step an item runs, as (tool kind, detail), for the items manut shows as steps.
    fn item_step(&mut self, item: &Value) -> Option<(String, String)> {
        let iid = s(item, "id");
        Some(match s(item, "type").as_str() {
            "commandExecution" => ("terminal".into(), clip(&Codex::command_of(item), 160)),
            "fileChange" => {
                let detail = self.file_changes(item);
                let paths: Vec<String> = item.get("changes").and_then(Value::as_array).into_iter().flatten().map(|c| rel(&s(c, "path"), &self.cwd)).filter(|p| !p.is_empty()).collect();
                match codex_change(item) {
                    Some(c) => self.change_paths.insert(iid.clone(), c),
                    None => self.change_paths.remove(&iid),
                };
                self.changes.insert(iid, clip(&paths.join(", "), 120));
                ("patch".into(), detail)
            }
            "mcpToolCall" => (s(item, "tool"), format!("{}.{}", s(item, "server"), s(item, "tool"))),
            "dynamicToolCall" => (tool_kind(&s(item, "tool")).to_string(), tool_detail(&item["arguments"])),
            "webSearch" => ("web_search".into(), s(item, "query")),
            "imageView" => ("read_file".into(), rel(&s(item, "path"), &self.cwd)),
            "sleep" => {
                let secs = item.get("durationMs").and_then(Value::as_u64).unwrap_or(0) / 1000;
                ("Waiting".into(), if secs > 0 { format!("{secs}s") } else { String::new() })
            }
            _ => return None,
        })
    }
    fn file_changes(&self, item: &Value) -> String {
        let files: Vec<(String, u64, u64)> = item
            .get("changes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|c| !s(c, "path").is_empty())
            .map(|c| {
                let diff = s(c, "diff");
                let (a, d) = match c.get("kind").map(|k| s(k, "type")).as_deref() {
                    Some("add") => (lines_of(&diff), 0),
                    Some("delete") => (0, lines_of(&diff)),
                    _ => unified_counts(&diff),
                };
                (rel(&s(c, "path"), &self.cwd), a, d)
            })
            .collect();
        edit_detail(&files)
    }
}

impl Adapter for Codex {
    fn name(&self) -> &str {
        "Codex"
    }

    fn start(&mut self) -> Step {
        let mut st = Step::default();
        self.call(&mut st, "initialize", json!({"clientInfo": {"name": "manut", "title": "Manut AI", "version": env!("CARGO_PKG_VERSION")}, "capabilities": {"experimentalApi": false}}));
        st
    }

    fn in_turn(&self) -> bool {
        self.turn
    }

    fn on_line(&mut self, line: &str) -> Step {
        let mut st = Step::default();
        let Ok(v) = serde_json::from_str::<Value>(line) else { return st };
        let method = s(&v, "method");
        let id = v.get("id").cloned();
        // a response to one of our calls
        if method.is_empty() {
            let Some(n) = id.as_ref().and_then(Value::as_u64) else { return st };
            let what = self.calls.remove(&n).unwrap_or("");
            if let Some(err) = v.get("error") {
                let msg = s(err, "message");
                if what == "thread/resume" {
                    // The thread to continue is gone (deleted or archived: "no rollout found"): start a new one in the
                    // same folder, say so, and send what was queued to it once Codex names it.
                    self.resume = None;
                    st.emit(ev("session.note", json!({"kind": "new_conversation", "text": clip(&format!("The earlier Codex conversation was not found ({msg}); a new one started."), 240)})));
                    let params = self.thread_params(json!({"cwd": self.cwd.clone()}));
                    self.call(&mut st, "thread/start", params);
                } else if what == "thread/revert" {
                    self.revert_to = None;
                    st.emit(ev("session.error", json!({"message": clip(&format!("Not taken back: {msg}"), 200)})));
                } else if what == "turn/start" {
                    self.end(&mut st, "error", Some(clip(&msg, 200)));
                } else if what == "turn/steer" {
                    // the turn ended or moved on first: the message never reached it, and says so
                    if let Some(id) = self.steers.remove(&n) {
                        self.waiting.refused(&mut st, &id);
                    }
                    st.emit(ev("status", json!({"text": clip(&format!("Codex did not take the steer: {msg}"), 160)})));
                } else if what == "turn/interrupt" && self.turn {
                    // a refused Stop says so where the person looks: the running turn's line
                    st.emit(ev("status", json!({"text": clip(&format!("Codex did not stop: {msg}"), 160)})));
                } else if what == "thread/start" {
                    // no thread to send to: a message waiting for one ends its turn with the reason
                    self.queued.clear();
                    let m = clip(&format!("Codex could not start a conversation: {msg}"), 200);
                    if self.turn {
                        self.end(&mut st, "error", Some(m));
                    } else {
                        st.emit(ev("session.error", json!({"message": m})));
                    }
                } else {
                    st.emit(ev("session.error", json!({"message": format!("{what}: {msg}")})));
                }
                return st;
            }
            let r = &v["result"];
            match what {
                "initialize" => {
                    st.out(json!({"method": "initialized"}));
                    match self.resume.clone() {
                        Some(thread) => {
                            let params = self.thread_params(json!({"threadId": thread}));
                            self.call(&mut st, "thread/resume", params)
                        }
                        None => {
                            let params = self.thread_params(json!({"cwd": self.cwd.clone()}));
                            self.call(&mut st, "thread/start", params)
                        }
                    }
                    self.call(&mut st, "model/list", json!({}));
                    let cwd = self.cwd.clone();
                    self.call(&mut st, "skills/list", json!({"cwds": [cwd]}));
                }
                "thread/start" | "thread/resume" => {
                    self.thread = r["thread"].get("id").and_then(Value::as_str).map(String::from);
                    self.model_id = s(r, "model");
                    let mut f = json!({"agent_session": self.thread.clone().unwrap_or_default(), "model": self.label(&self.model_id)});
                    let policy = s(r, "approvalPolicy");
                    let sandbox = r.get("sandbox").map(|x| s(x, "type")).unwrap_or_default();
                    // the thread's own mode when it is one of ours; any other (Codex's config) shows as the agent's
                    f["mode"] = Value::String(codex_mode_of(&policy, &sandbox).unwrap_or("").into());
                    if !policy.is_empty() {
                        f["approval"] = Value::String(policy);
                    }
                    if !sandbox.is_empty() {
                        f["sandbox"] = Value::String(sandbox);
                    }
                    let effort = s(r, "reasoningEffort");
                    if !effort.is_empty() {
                        f["effort"] = Value::String(effort);
                    }
                    // a resumed thread carries the name Codex (or the person) gave it
                    let name = title_of(&s(&r["thread"], "name"));
                    if !name.is_empty() {
                        f["title"] = Value::String(name);
                    }
                    st.emit(ev("session.info", f));
                    if let Some(e) = self.efforts_event(&self.model_id) {
                        st.emit(e);
                    }
                    for (text, images, id) in std::mem::take(&mut self.queued) {
                        self.turn_start(&mut st, text, &images, &id);
                    }
                }
                "turn/start" => {
                    if let Some(t) = r["turn"].get("id").and_then(Value::as_str) {
                        self.named(&mut st, t);
                    }
                }
                // the thread is back to before the person's last turn (its files stay as they are)
                // the steer was taken: its request is done (the message's own userMessage item says so)
                "turn/steer" => {
                    self.steers.remove(&n);
                }
                "thread/revert" => {
                    match self.revert_to.take() {
                        // a rewind to a turn: the chat goes back to before the first message of the turn that went
                        Some(at) => {
                            let gone = self.turns.get(at).and_then(|t| self.msg_turns.iter().find(|(_, x)| x == t)).map(|(b, _)| b.clone()).unwrap_or_default();
                            self.turns.truncate(at);
                            st.emit(ev("rewound", json!({"id": gone})));
                        }
                        None => {
                            self.turns.pop();
                            st.emit(ev("rewound", json!({})));
                        }
                    }
                    let turns = &self.turns;
                    self.msg_turns.retain(|(_, t)| turns.contains(t));
                    st.emit(ev("session.info", json!({"rewind": !self.turns.is_empty()})));
                }
                "model/list" => {
                    let list: Vec<&Value> = r.get("data").and_then(Value::as_array).into_iter().flatten().filter(|m| !m.get("hidden").and_then(Value::as_bool).unwrap_or(false)).collect();
                    for m in &list {
                        let label = s(m, "displayName");
                        if !label.is_empty() {
                            self.labels.insert(s(m, "model"), label);
                        }
                    }
                    for m in &list {
                        let levels: Vec<Value> = m.get("supportedReasoningEfforts").and_then(Value::as_array).into_iter().flatten().map(|e| Value::String(s(e, "reasoningEffort"))).filter(|e| e != "").collect();
                        self.efforts.insert(s(m, "model"), Value::Array(levels));
                    }
                    let options: Vec<Value> = list.iter().map(|m| json!({"id": s(m, "model"), "label": s(m, "displayName"), "detail": s(m, "description")})).collect();
                    st.emit(ev("session.models", json!({"options": options})));
                    if let Some(e) = self.efforts_event(&self.model_id) {
                        st.emit(e);
                    }
                    if !self.model_id.is_empty() {
                        st.emit(ev("session.info", json!({"model": self.label(&self.model_id)})));
                    }
                }
                "skills/list" => {
                    // Codex's skills, typed as `$name`
                    let mut commands = Vec::new();
                    for sk in r.get("data").and_then(Value::as_array).into_iter().flatten().flat_map(|d| d.get("skills").and_then(Value::as_array).into_iter().flatten()) {
                        let name = s(sk, "name");
                        if name.is_empty() || sk.get("enabled").and_then(Value::as_bool) == Some(false) || self.skills.contains_key(&name) {
                            continue;
                        }
                        self.skills.insert(name.clone(), s(sk, "path"));
                        let d = if s(sk, "shortDescription").is_empty() { s(sk, "description") } else { s(sk, "shortDescription") };
                        commands.push(command_entry(&name, &d, "", "skill", "$"));
                    }
                    if !commands.is_empty() {
                        st.emit(ev("session.commands", json!({"commands": commands})));
                    }
                }
                _ => {}
            }
            return st;
        }
        let p = v.get("params").cloned().unwrap_or(Value::Null);
        // a request from the server (approvals, questions); anything we do not handle is answered with an error
        let thread = s(&p, "threadId");
        if let Some(rpc_id) = id {
            let key = format!("codex-{}", rpc_id);
            let n = st.events.len();
            match method.as_str() {
                "item/commandExecution/requestApproval" => {
                    let reason = s(&p, "reason");
                    let title = if reason.is_empty() { "Run this command?".to_string() } else { clip(&reason, 120) };
                    let cwd = if s(&p, "cwd").is_empty() { self.cwd.clone() } else { s(&p, "cwd") };
                    self.pending.insert(key.clone(), CodexAsk::Command(rpc_id));
                    // the title is Codex's reason, for the person; Kit's dial reads the command itself (ask_tool.rs)
                    let tool = codex_command_tool(&p, &self.cwd);
                    st.emit(ev("approval.request", with_cwd(json!({"request_id": key, "title": title, "command": Codex::command_of(&p), "choices": CHOICES, "tool": tool}), &cwd)));
                }
                "item/fileChange/requestApproval" => {
                    let item = s(&p, "itemId");
                    let files = self.changes.get(&item).cloned().unwrap_or_default();
                    let title = if files.is_empty() { "Allow Codex to change files?".to_string() } else { format!("Allow Codex to change {files}?") };
                    self.pending.insert(key.clone(), CodexAsk::File(rpc_id));
                    // the title's list is cut short for the card; the dial gets every path the item names
                    let tool = codex_change_tool(self.change_paths.get(&item), &p, &self.cwd);
                    st.emit(ev("approval.request", with_cwd(json!({"request_id": key, "title": title, "command": "", "choices": CHOICES, "tool": tool}), &self.cwd)));
                }
                "item/tool/requestUserInput" => {
                    let mut qids = Vec::new();
                    let mut qs = Vec::new();
                    for q in p.get("questions").and_then(Value::as_array).into_iter().flatten() {
                        let choices: Vec<String> = q.get("options").and_then(Value::as_array).into_iter().flatten().map(|o| s(o, "label")).filter(|l| !l.is_empty()).collect();
                        let text = if s(q, "question").is_empty() { s(q, "header") } else { s(q, "question") };
                        qids.push(s(q, "id"));
                        qs.push((s(q, "id"), text, choices, false));
                    }
                    if qs.is_empty() {
                        st.out(json!({"id": rpc_id, "result": {"answers": {}}}));
                    } else {
                        self.pending.insert(key.clone(), CodexAsk::Input(rpc_id, qids));
                        st.emit(clarify_event(&key, &qs));
                    }
                }
                _ => st.out(json!({"id": rpc_id, "error": {"code": -32601, "message": "not supported by Manut AI"}})),
            }
            // asked inside a sub-agent: the card says which one
            if self.is_helper(&thread) {
                let name = self.helper(&thread, "", "").name.clone();
                tag_asks(&mut st, n, &thread, &name);
                self.ask_helpers.insert(key, thread.clone());
            }
            return st;
        }
        self.adopt(&thread, &method, &p);
        if self.is_helper(&thread) && method != "serverRequest/resolved" {
            self.on_helper_line(&mut st, &thread, &method, &p);
            return st;
        }
        let item = p.get("item").cloned().unwrap_or(Value::Null);
        match method.as_str() {
            // the thread got a name (Codex's own, or a rename elsewhere): the session takes it
            "thread/name/updated" if self.thread.as_deref() == Some(s(&p, "threadId").as_str()) => {
                let t = title_of(&s(&p, "threadName"));
                if !t.is_empty() {
                    st.emit(ev("session.info", json!({"title": t})));
                }
            }
            "turn/started" => {
                if !self.turn {
                    self.turn = true;
                    st.emit(ev("turn.start", json!({})));
                }
                if let Some(t) = p["turn"].get("id").and_then(Value::as_str) {
                    self.named(&mut st, t);
                }
            }
            // how full the context is, as Codex counts it (the last request's tokens against the model's window)
            "thread/tokenUsage/updated" => {
                let u = &p["tokenUsage"];
                if let (Some(used), Some(max)) = (u["last"].get("totalTokens").and_then(Value::as_u64), u.get("modelContextWindow").and_then(Value::as_u64).filter(|m| *m > 0)) {
                    st.emit(ev("session.usage", json!({"used": used, "max": max})));
                }
            }
            "item/agentMessage/delta" => {
                let t = s(&p, "delta");
                if !t.is_empty() {
                    st.emit(ev("delta", json!({"text": t})));
                }
            }
            // its reasoning: the summary when Codex writes one, else the raw text
            "item/reasoning/summaryTextDelta" => {
                self.summarized.insert(s(&p, "itemId"));
                st.emit(thinking_event(&s(&p, "delta")));
            }
            "item/reasoning/summaryPartAdded" => st.emit(thinking_event("\n\n")),
            "item/reasoning/textDelta" => {
                let t = if self.summarized.contains(&s(&p, "itemId")) { String::new() } else { s(&p, "delta") };
                st.emit(thinking_event(&t));
            }
            // its plan: the whole list each time, one checklist that changes in place
            "turn/plan/updated" if self.turn => {
                let items: Vec<(String, String)> = p
                    .get("plan")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|x| {
                        let st = match s(x, "status").as_str() {
                            "inProgress" => "in_progress",
                            "completed" => "completed",
                            _ => "pending",
                        };
                        (s(x, "step"), st.to_string())
                    })
                    .collect();
                st.emit(plan_event(&items));
            }
            // a file change's patch moved before it ran (Codex reworked it): the diff view follows
            "item/fileChange/patchUpdated" => {
                let files = codex_diff(&json!({"changes": p.get("changes").cloned().unwrap_or(Value::Null)}), &self.cwd);
                if !files.is_empty() {
                    st.emit(ev("tool.diff", json!({"tool_id": s(&p, "itemId"), "files": files})));
                }
            }
            "item/started" => {
                match s(&item, "type").as_str() {
                    // Codex recorded a message the person sent (our id as its clientId)
                    "userMessage" => {
                        let cid = s(&item, "clientId");
                        if !cid.is_empty() {
                            // the turn it went into (Codex names the turn before it records the message)
                            if let Some(t) = self.turn_id.clone() {
                                if !self.msg_turns.iter().any(|(b, _)| *b == cid) {
                                    self.msg_turns.push((cid.clone(), t));
                                }
                            }
                            self.waiting.take_id(&mut st, &cid);
                        }
                    }
                    "subAgentActivity" => self.helper_activity(&mut st, &item, false),
                    _ => {
                        if let Some((name, detail)) = self.item_step(&item) {
                            st.emit(ev("tool.start", json!({"tool_id": s(&item, "id"), "name": name, "detail": detail})));
                            // a file change carries its patch: the diff view shows it
                            if s(&item, "type") == "fileChange" {
                                let files = codex_diff(&item, &self.cwd);
                                if !files.is_empty() {
                                    st.emit(ev("tool.diff", json!({"tool_id": s(&item, "id"), "files": files})));
                                }
                            }
                        }
                    }
                }
            }
            "item/completed" => {
                let iid = s(&item, "id");
                match s(&item, "type").as_str() {
                    "subAgentActivity" => self.helper_activity(&mut st, &item, true),
                    "agentMessage" => {
                        // a question in the message: a question card instead of the bubble
                        let qs: Vec<(String, String, Vec<String>, bool)> = item
                            .get("questions")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .enumerate()
                            .map(|(i, q)| {
                                let choices = q.get("options").and_then(Value::as_array).into_iter().flatten().filter_map(|o| o.as_str().map(String::from)).collect();
                                (format!("q{}", i + 1), s(q, "title"), choices, false)
                            })
                            .filter(|q| !q.1.is_empty())
                            .collect();
                        if !qs.is_empty() {
                            self.pending.insert(iid.clone(), CodexAsk::Message);
                            st.emit(clarify_event(&iid, &qs));
                            return st;
                        }
                        let t = s(&item, "text");
                        if !t.trim().is_empty() {
                            st.emit(ev("message", json!({"id": iid, "text": t})));
                        }
                    }
                    "commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall" | "webSearch" | "imageView" | "sleep" => {
                        // what the change finally was (it may differ from what it asked)
                        if s(&item, "type") == "fileChange" {
                            let files = codex_diff(&item, &self.cwd);
                            if !files.is_empty() {
                                st.emit(ev("tool.diff", json!({"tool_id": iid, "files": files})));
                            }
                        }
                        let status = s(&item, "status");
                        let ok = !matches!(status.as_str(), "failed" | "declined");
                        let ms = item.get("durationMs").and_then(Value::as_u64).unwrap_or(0);
                        if s(&item, "type") == "commandExecution" {
                            // a command's step carries what it printed, for the page to read a test run's result from
                            st.emit(ev("tool.end", command_end(&iid, ok, ms, &Codex::command_of(&item), &s(&item, "aggregatedOutput"), status == "declined")));
                        } else {
                            st.emit(ev("tool.end", json!({"tool_id": iid, "name": "", "ok": ok, "ms": ms})));
                        }
                    }
                    _ => {}
                }
            }
            // a request we were asked is no longer open (Stop, or answered elsewhere)
            "serverRequest/resolved" => {
                let key = format!("codex-{}", p.get("requestId").cloned().unwrap_or(Value::Null));
                if self.pending.remove(&key).is_some() {
                    st.emit(ev("prompt.expired", json!({"request_id": key, "reason": "cancelled"})));
                }
            }
            "turn/completed" => {
                let t = &p["turn"];
                match s(t, "status").as_str() {
                    "interrupted" => self.end(&mut st, "interrupted", None),
                    "failed" => {
                        let e = t.get("error").map(|e| s(e, "message")).unwrap_or_default();
                        let e = if self.unauthorized || e.contains("401 Unauthorized") { CODEX_SIGNED_OUT.to_string() } else { clip(&e, 200) };
                        self.end(&mut st, "error", Some(e));
                    }
                    _ => self.end(&mut st, "done", None),
                }
                self.unauthorized = false;
            }
            "error" => {
                let e = &p["error"];
                let info = e.get("codexErrorInfo").cloned().unwrap_or(Value::Null);
                if info.to_string().contains("\"httpStatusCode\":401") {
                    self.unauthorized = true;
                }
                // a status shows only while a turn runs; outside one an error is a note under the chat
                if p.get("willRetry").and_then(Value::as_bool).unwrap_or(false) {
                    // "Reconnecting... 2/5": say it on the progress line instead of a silent wait
                    if self.turn {
                        st.emit(ev("status", json!({"text": clip(&s(e, "message"), 120)})));
                    }
                } else if !self.unauthorized {
                    let text = clip(&format!("Error: {}", s(e, "message")), 160);
                    st.emit(if self.turn { ev("status", json!({"text": text})) } else { ev("session.error", json!({"message": text})) });
                }
            }
            _ => {}
        }
        st
    }

    fn on_input(&mut self, input: Input) -> Result<Step, String> {
        let mut st = Step::default();
        match input {
            Input::Send { text, images, id } => {
                // a message sent while a turn runs joins it once Codex records it
                self.waiting.push(&mut st, id.clone(), self.turn);
                if !self.turn {
                    self.turn = true;
                    st.emit(ev("turn.start", json!({})));
                }
                if self.thread.is_none() {
                    self.queued.push((text, images, id));
                } else {
                    self.turn_start(&mut st, text, &images, &id);
                }
            }
            Input::Interrupt => match (self.thread.clone(), self.turn_id.clone()) {
                (Some(thread), Some(turn)) => self.call(&mut st, "turn/interrupt", json!({"threadId": thread, "turnId": turn})),
                _ if !self.turn => return Err("nothing is running".into()),
                // the message still waits for the thread: it is never sent
                (None, _) => {
                    self.queued.clear();
                    self.waiting.all_dropped(&mut st);
                    self.end(&mut st, "interrupted", None);
                }
                // sent, but Codex has not named the turn yet
                (Some(_), None) => self.stop_asked = true,
            },
            Input::Approve { request_id, choice } => {
                let rpc_id = match self.pending.remove(&request_id) {
                    Some(CodexAsk::Command(id)) | Some(CodexAsk::File(id)) => id,
                    Some(other) => {
                        self.pending.insert(request_id, other);
                        return Err("not an approval".into());
                    }
                    None => return Err("no such request".into()),
                };
                let decision = match choice.as_str() {
                    "deny" => "decline",
                    "once" => "accept",
                    "session" => "acceptForSession",
                    other => return Err(format!("unknown choice {other}")),
                };
                st.out(json!({"id": rpc_id, "result": {"decision": decision}}));
            }
            Input::Clarify { request_id, answer } => match self.pending.remove(&request_id) {
                Some(CodexAsk::Input(rpc_id, qids)) => {
                    let mut answers = Map::new();
                    for (qid, a) in answers_by_qid(&answer, &qids) {
                        let list: Vec<String> = a.map(|t| t.split(", ").map(String::from).filter(|x| !x.is_empty()).collect()).unwrap_or_default();
                        answers.insert(qid, json!({"answers": list}));
                    }
                    st.out(json!({"id": rpc_id, "result": {"answers": answers}}));
                }
                Some(CodexAsk::Message) => {
                    let text = answers_by_qid(&answer, &["q1".to_string()]).into_iter().filter_map(|(_, a)| a).collect::<Vec<_>>().join("\n");
                    let thread = self.thread.clone().unwrap_or_default();
                    match self.turn_id.clone() {
                        // the turn is still waiting for the answer: steer it
                        Some(turn) if self.turn => self.call(&mut st, "turn/steer", json!({"threadId": thread, "input": [{"type": "text", "text": text}], "expectedTurnId": turn})),
                        _ => {
                            if !self.turn {
                                self.turn = true;
                                st.emit(ev("turn.start", json!({})));
                            }
                            self.turn_start(&mut st, text, &[], "");
                        }
                    }
                }
                Some(other) => {
                    self.pending.insert(request_id, other);
                    return Err("not a question".into());
                }
                None => return Err("no such question".into()),
            },
            // app-server's own steer: the text joins the running turn (`expectedTurnId` must be the active turn)
            Input::Steer { id, text } => match (self.thread.clone(), self.turn_id.clone()) {
                (Some(thread), Some(turn)) if self.turn => {
                    self.waiting.steer(id.clone());
                    let mut p = json!({"threadId": thread, "input": [{"type": "text", "text": text}], "expectedTurnId": turn});
                    if !id.is_empty() {
                        p["clientUserMessageId"] = Value::String(id.clone());
                    }
                    self.call(&mut st, "turn/steer", p);
                    self.steers.insert(self.seq, id);
                }
                _ => return Err("nothing is running to steer".into()),
            },
            Input::Model { model } => {
                // app-server takes the model per turn; the next turn uses it
                self.model = Some(model.clone());
                st.emit(ev("session.info", json!({"model": self.label(&model)})));
                if let Some(e) = self.efforts_event(&model) {
                    st.emit(e);
                }
            }
            // per turn as well: approval policy and sandbox go with the next turn/start (and Codex keeps them)
            Input::Mode { mode } => {
                let m = codex_mode(&mode).ok_or_else(|| format!("not a mode Manut AI offers: {mode}"))?;
                self.mode = Some(m);
                st.emit(ev("session.info", json!({"mode": mode})));
            }
            // Codex's own revert: the thread goes back to before the person's last turn
            Input::Rewind => {
                if self.turn {
                    return Err("wait until the turn ends".into());
                }
                let (Some(thread), Some(turn)) = (self.thread.clone(), self.turns.last().cloned()) else { return Err("nothing to take back".into()) };
                self.revert_to = None;
                self.call(&mut st, "thread/revert", json!({"threadId": thread, "beforeTurnId": turn}));
            }
            // a rewind to a turn: the thread goes back to before the turn the named message went into
            Input::RewindTo { id } => {
                if self.turn {
                    return Err("wait until the turn ends".into());
                }
                let at = self.msg_turns.iter().find(|(b, _)| !id.is_empty() && *b == id).and_then(|(_, t)| self.turns.iter().position(|x| x == t));
                let (Some(thread), Some(at)) = (self.thread.clone(), at) else { return Err("Codex cannot take that message back here".into()) };
                self.revert_to = Some(at);
                let turn = self.turns[at].clone();
                self.call(&mut st, "thread/revert", json!({"threadId": thread, "beforeTurnId": turn}));
            }
            Input::Effort { effort } => {
                let model = self.model.clone().unwrap_or_else(|| self.model_id.clone());
                let known = self.efforts.get(&model).and_then(Value::as_array).is_some_and(|l| l.iter().any(|e| e == effort.as_str()));
                if !known {
                    return Err(format!("{model} has no effort {effort}"));
                }
                self.effort = Some(effort.clone());
                st.emit(ev("session.info", json!({"effort": effort})));
            }
        }
        Ok(st)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_chat::tests::{
        ask_tools,
        codex_up,
        ends,
        fixture,
        names,
        of,
        of_kind,
        real,
        replay,
        run,
        sent_with,
        steer,
        text_of,
        tools,
        with_pic,
        written,
    };

    // ---- Codex app-server (fixture from the protocol schema, codex-rs/app-server-protocol) --------

    #[test]
    fn codex_handshake_thread_then_turn_with_command_approval() {
        let mut x = Codex::new("/w/proj", None);
        let st = x.start();
        let init: Value = serde_json::from_str(&st.write[0]).unwrap();
        assert_eq!((init["id"].as_u64(), s(&init, "method")), (Some(1), "initialize".to_string()));
        assert_eq!(init["params"]["clientInfo"]["name"], "manut");
        // text typed before the thread exists waits for it
        let st = x.on_input(Input::send("run the tests")).unwrap();
        assert_eq!(names(&st.events), ["turn.start"]);
        assert!(st.write.is_empty());

        let lines = fixture("codex-turn.jsonl");
        let st = run(&mut x, &lines[..2]);
        let sent: Vec<Value> = st.write.iter().map(|w| serde_json::from_str(w).unwrap()).collect();
        assert_eq!(s(&sent[0], "method"), "initialized");
        assert_eq!(sent[1]["method"], "thread/start");
        assert_eq!(sent[1]["params"]["cwd"], "/w/proj");
        assert_eq!(sent[2]["method"], "model/list");
        assert_eq!(sent[3]["method"], "skills/list");
        assert_eq!(sent[4]["method"], "turn/start");
        assert_eq!(sent[4]["params"]["threadId"], "thr_1");
        assert_eq!(sent[4]["params"]["input"][0]["text"], "run the tests");
        assert_eq!(s(&st.events[0], "agent_session"), "thr_1");
        assert_eq!(s(&st.events[0], "model"), "gpt-6.1-sol");

        let at = lines.iter().position(|l| l.contains("requestApproval")).unwrap();
        let st = run(&mut x, &lines[2..=at]);
        let tool = st.events.iter().find(|e| s(e, "event") == "tool.start").unwrap();
        assert_eq!((s(tool, "name"), s(tool, "detail")), ("terminal".into(), "pnpm test".into()));
        let card = st.events.last().unwrap();
        assert_eq!(s(card, "title"), "Run this command?");
        assert_eq!(s(card, "command"), "pnpm test");
        let ans = x.on_input(Input::Approve { request_id: s(card, "request_id"), choice: "session".into() }).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&ans.write[0]).unwrap(), json!({"id": 90, "result": {"decision": "acceptForSession"}}));

        let st = run(&mut x, &lines[at + 1..]);
        assert_eq!(text_of(&st.events, "delta").concat(), "All 12 tests pass.");
        assert_eq!(text_of(&st.events, "message"), ["All 12 tests pass."]);
        let end = st.events.iter().find(|e| s(e, "event") == "tool.end").unwrap();
        assert_eq!(end["ok"], true);
        // a command's step hands on what it printed, for the page to read the test run's result from
        assert_eq!(end["output"], "12 passed\n");
        assert_eq!(st.events.last().unwrap(), &json!({"event": "turn.end", "outcome": "done"}));
    }

    #[test]
    fn codex_interrupt_decline_and_unknown_requests() {
        let mut x = Codex::new("/w", None);
        x.start();
        run(&mut x, &fixture("codex-turn.jsonl")[..2]);
        x.on_input(Input::send("go")).unwrap();
        x.on_line(r#"{"method":"turn/started","params":{"threadId":"thr_1","turn":{"id":"turn_9","status":"inProgress","items":[]}}}"#);
        let st = x.on_input(Input::Interrupt).unwrap();
        let req: Value = serde_json::from_str(&st.write[0]).unwrap();
        assert_eq!(req["method"], "turn/interrupt");
        assert_eq!(req["params"], json!({"threadId": "thr_1", "turnId": "turn_9"}));
        let st = x.on_line(r#"{"method":"turn/completed","params":{"threadId":"thr_1","turn":{"id":"turn_9","status":"interrupted","items":[],"error":null}}}"#);
        assert_eq!(st.events[0], json!({"event": "turn.end", "outcome": "interrupted"}));

        let st = x.on_line(r#"{"id":"77","method":"item/fileChange/requestApproval","params":{"threadId":"thr_1","turnId":"t","itemId":"i9","startedAtMs":1}}"#);
        let rid = s(&st.events[0], "request_id");
        let ans: Value = serde_json::from_str(&x.on_input(Input::Approve { request_id: rid, choice: "deny".into() }).unwrap().write[0]).unwrap();
        assert_eq!(ans, json!({"id": "77", "result": {"decision": "decline"}}));
        let st = x.on_line(r#"{"id":5,"method":"item/tool/requestUserInput","params":{}}"#);
        assert_eq!(serde_json::from_str::<Value>(&st.write[0]).unwrap(), json!({"id": 5, "result": {"answers": {}}}));
        let st = x.on_line(r#"{"id":6,"method":"item/permissions/requestApproval","params":{}}"#);
        assert_eq!(serde_json::from_str::<Value>(&st.write[0]).unwrap()["error"]["code"], -32601);
    }

    // -- Codex --

    #[test]
    fn real_codex_init_reads_thread_model_label_and_policy() {
        let mut x = Codex::new("/w/proj", None);
        x.start();
        let st = run(&mut x, &real("codex-init.jsonl"));
        let w = written(&st);
        assert_eq!(s(&w[0], "method"), "initialized");
        assert_eq!(w[1]["method"], "thread/start");
        let infos = of(&st.events, "session.info");
        assert_eq!(s(infos[0], "agent_session"), "01a1c3b9-4b7f-7542-900c-c5f4dc80eefa");
        assert_eq!(s(infos[0], "approval"), "untrusted");
        assert_eq!(s(infos.last().unwrap(), "model"), "GPT-6.1-Sol", "the label once model/list arrives");
    }

    #[test]
    fn real_codex_1_plain_answer() {
        let mut x = codex_up();
        x.on_input(Input::send("2+2")).unwrap();
        let st = replay(&mut x, &["codex-1-plain.jsonl"], &[]);
        assert_eq!(text_of(&st.events, "message"), ["2 + 2 = 4."]);
        assert_eq!(text_of(&st.events, "delta").concat(), "2 + 2 = 4.");
        assert_eq!(ends(&st.events), [("done".into(), "".into())]);
    }

    #[test]
    fn real_codex_2_command_shows_unwrapped_deny_once_session() {
        let mut x = codex_up();
        x.on_input(Input::send("mkdir")).unwrap();
        let st = replay(&mut x, &["codex-2-approvals.jsonl"], &["deny", "once", "session", "once"]);
        // Codex reports `/bin/zsh -lc 'mkdir -p d1'`; the row and the card show the command
        assert_eq!(tools(&st.events), [("terminal", "mkdir -p d1"), ("terminal", "mkdir -p d2"), ("terminal", "mkdir -p d3"), ("terminal", "mkdir -p d4")].map(|(a, b)| (a.to_string(), b.to_string())));
        let cards = of(&st.events, "approval.request");
        assert_eq!(cards.iter().map(|c| s(c, "command")).collect::<Vec<_>>(), ["mkdir -p d1", "mkdir -p d2", "mkdir -p d3", "mkdir -p d4"]);
        assert_eq!(s(cards[0], "cwd"), "/w/proj");
        let decisions: Vec<String> = written(&st).iter().map(|w| s(&w["result"], "decision")).collect();
        assert_eq!(decisions, ["decline", "accept", "acceptForSession", "accept"]);
        let oks: Vec<bool> = of(&st.events, "tool.end").iter().map(|e| e["ok"].as_bool().unwrap()).collect();
        assert_eq!(oks, [false, true, true, true]);
        assert_eq!(ends(&st.events), [("done".into(), "".into())]);
    }

    #[test]
    fn real_codex_3_file_change_card_and_diff_summary() {
        let mut x = codex_up();
        x.on_input(Input::send("notes")).unwrap();
        let st = replay(&mut x, &["codex-3-edit.jsonl"], &["once"]);
        assert_eq!(tools(&st.events), [("patch".to_string(), "notes.txt +1".to_string())]);
        let card = of(&st.events, "approval.request")[0];
        assert_eq!(s(card, "title"), "Allow Codex to change notes.txt?");
        assert_eq!(s(&written(&st)[0]["result"], "decision"), "accept");
        assert_eq!(ends(&st.events), [("done".into(), "".into())]);
    }

    #[test]
    fn a_codex_card_shows_the_command_it_runs_not_a_parsed_part_of_it() {
        // Codex's parsed actions describe a command; the card shows the command itself whenever Codex sends one
        let p = json!({"command": "cat notes.txt | sh", "commandActions": [{"type": "read", "command": "cat notes.txt", "name": "notes.txt"}]});
        assert_eq!(Codex::command_of(&p), "cat notes.txt | sh");
        // its shell wrapper is still taken off, and a parsed action stands in only when there is no command at all
        assert_eq!(Codex::command_of(&json!({"command": "/bin/zsh -lc 'mkdir -p d1'", "commandActions": [{"type": "unknown", "command": "mkdir -p d1"}]})), "mkdir -p d1");
        assert_eq!(Codex::command_of(&json!({"command": "", "commandActions": [{"type": "unknown", "command": "ls"}]})), "ls");
    }

    #[test]
    fn real_codex_asks_name_the_command_it_runs_and_every_file() {
        let mut x = codex_up();
        x.on_input(Input::send("mkdir")).unwrap();
        // `/bin/zsh -lc 'mkdir -p d1'`: the script, in the folder Codex names
        let want: Vec<Value> = ["d1", "d2", "d3", "d4"].iter().map(|d| json!({"kind": "command", "line": format!("mkdir -p {d}"), "cwd": "/w/proj"})).collect();
        assert_eq!(ask_tools(&mut x, &["codex-2-approvals.jsonl"]), want);
        let mut x = codex_up();
        x.on_input(Input::send("sleep")).unwrap();
        let st = run(&mut x, &real("codex-4-stop.jsonl"));
        assert_eq!(of(&st.events, "approval.request")[0]["tool"]["line"], "sleep 30; echo finished");
        // a file change names its item's paths, which arrived before its approval
        let mut x = codex_up();
        x.on_input(Input::send("notes")).unwrap();
        assert_eq!(ask_tools(&mut x, &["codex-3-edit.jsonl"]), [json!({"kind": "edit", "paths": ["/w/proj/notes.txt"], "cwd": "/w/proj"})]);
    }

    #[test]
    fn real_codex_4_stop_closes_the_open_card_and_ends_interrupted() {
        let mut x = codex_up();
        x.on_input(Input::send("sleep")).unwrap();
        let st = run(&mut x, &real("codex-4-stop.jsonl"));
        let card = of(&st.events, "approval.request")[0].clone();
        assert_eq!(s(&card, "command"), "sleep 30; echo finished");
        let w = written(&x.on_input(Input::Interrupt).unwrap());
        assert_eq!(w[0]["method"], "turn/interrupt");
        let rest = run(&mut x, &real("codex-4-stopped.jsonl"));
        assert_eq!(ends(&rest.events), [("interrupted".into(), "".into())]);
        assert!(!x.in_turn());
        // the card is gone with its turn: a late answer is refused, nothing is written
        assert!(x.on_input(Input::Approve { request_id: s(&card, "request_id"), choice: "once".into() }).is_err());
    }

    #[test]
    fn real_codex_5_question_in_a_message_becomes_a_question_card() {
        let mut x = codex_up();
        x.on_input(Input::send("ask")).unwrap();
        let lines = real("codex-5-question.jsonl");
        let at = lines.iter().position(|l| l.contains("\"questions\":[{")).unwrap();
        let at = at + lines[at + 1..].iter().position(|l| l.contains("item/completed")).map(|i| i + 1).unwrap_or(0);
        let st = run(&mut x, &lines[..=at]);
        let q = of(&st.events, "clarify.request")[0].clone();
        assert_eq!(s(&q, "question"), "Which greeting should I put in greet.txt?");
        assert_eq!(q["choices"], json!(["hello", "hi"]));
        assert!(text_of(&st.events, "message").is_empty(), "the card stands for the message");
        // Codex then sleeps waiting for the answer: the answer steers the running turn
        let w = written(&x.on_input(Input::Clarify { request_id: s(&q, "request_id"), answer: json!("hi") }).unwrap());
        assert_eq!(w[0]["method"], "turn/steer");
        assert_eq!(w[0]["params"]["input"][0]["text"], "hi");
        assert!(w[0]["params"]["expectedTurnId"].is_string());
        let rest = run(&mut x, &lines[at + 1..]);
        assert_eq!(tools(&rest.events), [("Waiting".to_string(), "60s".to_string())]);
        assert_eq!(ends(&rest.events), [("done".into(), "".into())]);
    }

    #[test]
    fn real_codex_5_answer_after_the_turn_ended_starts_a_new_turn() {
        let mut x = codex_up();
        x.on_input(Input::send("ask")).unwrap();
        let st = run(&mut x, &real("codex-5-question.jsonl"));
        let q = of(&st.events, "clarify.request")[0].clone();
        assert!(!x.in_turn());
        let ans = x.on_input(Input::Clarify { request_id: s(&q, "request_id"), answer: json!("hello") }).unwrap();
        assert_eq!(names(&ans.events), ["turn.start"]);
        assert_eq!(written(&ans)[0]["method"], "turn/start");
    }

    #[test]
    fn real_codex_6_bad_command_fails_its_step_only() {
        let mut x = codex_up();
        x.on_input(Input::send("bad")).unwrap();
        let st = replay(&mut x, &["codex-6-error.jsonl"], &["once"]);
        assert_eq!(tools(&st.events), [("terminal".to_string(), "definitely-not-a-command-xyz --flag".to_string())]);
        assert_eq!(of(&st.events, "tool.end")[0]["ok"], false);
        assert_eq!(text_of(&st.events, "message").last().unwrap(), "Exit code: 127.");
        assert_eq!(ends(&st.events), [("done".into(), "".into())]);
    }

    #[test]
    fn real_codex_7_model_applies_to_the_next_turn() {
        let mut x = codex_up();
        let st = x.on_input(Input::Model { model: "gpt-6-astra".into() }).unwrap();
        assert_eq!(s(&st.events[0], "model"), "GPT-6-Astra");
        let w = written(&x.on_input(Input::send("switched")).unwrap());
        assert_eq!((w[0]["method"].as_str(), w[0]["params"]["model"].as_str()), (Some("turn/start"), Some("gpt-6-astra")));
        let st = replay(&mut x, &["codex-7-model.jsonl"], &[]);
        assert_eq!(text_of(&st.events, "message"), ["switched"]);
    }

    #[test]
    fn real_codex_8_reopen_resumes_the_thread() {
        let id = "01a1c3b9-4b7f-7542-900c-c5f4dc80eefa";
        let mut x = Codex::new("/w/proj", Some(id));
        x.start();
        let st = run(&mut x, &real("codex-8-resume-init.jsonl"));
        let w = written(&st);
        assert_eq!(w[1]["method"], "thread/resume");
        assert_eq!(w[1]["params"]["threadId"], id);
        let st = run(&mut x, &real("codex-8-resume.jsonl"));
        assert_eq!(s(of(&st.events, "session.info")[0], "agent_session"), id);
        let st = x.on_input(Input::send("which file")).unwrap();
        assert_eq!(written(&st)[0]["params"]["threadId"], id);
        let st = replay(&mut x, &["codex-8-resume-turn.jsonl"], &[]);
        assert!(text_of(&st.events, "message")[0].contains("notes.txt"));
    }

    /// H5, recorded from the real Codex 0.167 (`thread/resume` onto a deleted thread): manut starts a new thread in the
    /// same folder, says so, and the message the person sent while it waited goes to the new thread.
    #[test]
    fn codex_resume_onto_a_gone_thread_starts_a_new_one_and_sends_what_waited() {
        let gone = "0badbeef-0000-4000-8000-000000000000";
        let mut x = Codex::new("/w/proj", Some(gone));
        x.start();
        let lines = real("codex-11-resume-gone.jsonl");
        // the person's message is sent before Codex has answered anything (manut reopened the chat by itself)
        let sent = x.on_input(Input::send("Reply with exactly: ok")).unwrap();
        assert_eq!(names(&sent.events), ["turn.start"]);
        assert!(sent.write.is_empty(), "no thread yet: the message waits");
        let st = run(&mut x, &lines[..5]);
        let w = written(&st);
        assert_eq!(w.iter().filter(|c| c["method"] == "thread/resume").count(), 1);
        // the resume error is said in the chat and answered with a new thread in the same folder, not a popover note
        let note = of(&st.events, "session.note");
        assert_eq!(note.len(), 1, "{:?}", st.events);
        assert_eq!(s(note[0], "kind"), "new_conversation");
        assert!(of(&st.events, "session.error").is_empty(), "{:?}", st.events);
        let start = w.iter().find(|c| c["method"] == "thread/start").expect("a new thread");
        assert_eq!(start["params"]["cwd"], "/w/proj");
        assert!(x.in_turn(), "the message is still on its way");
        let st = run(&mut x, &lines[5..]);
        let new = "01a1cb4b-0d4e-7751-aae4-9d65216fa4e6";
        assert_eq!(s(of(&st.events, "session.info")[0], "agent_session"), new);
        let w = written(&st);
        let turn = w.iter().find(|c| c["method"] == "turn/start").expect("the waiting message is sent");
        assert_eq!(turn["params"]["threadId"], new);
        assert_eq!(turn["params"]["input"][0]["text"], "Reply with exactly: ok");
        // Stop works on it like on any turn
        x.on_line(r#"{"method":"turn/started","params":{"threadId":"01a1cb4b-0d4e-7751-aae4-9d65216fa4e6","turn":{"id":"t1"}}}"#);
        assert_eq!(written(&x.on_input(Input::Interrupt).unwrap())[0]["method"], "turn/interrupt");
    }

    /// H5: when the new thread cannot start either, the waiting message ends its turn with the reason (no Working).
    #[test]
    fn codex_resume_and_new_thread_both_refused_end_the_waiting_turn() {
        let mut x = Codex::new("/w/proj", Some("0badbeef-0000-4000-8000-000000000000"));
        x.start();
        x.on_input(Input::send("hi")).unwrap();
        run(&mut x, &real("codex-11-resume-gone.jsonl")[..5]);
        let st = x.on_line(r#"{"id":5,"error":{"code":-32600,"message":"not signed in"}}"#);
        assert_eq!(ends(&st.events), [("error".into(), "Codex could not start a conversation: not signed in".into())]);
        assert!(!x.in_turn());
    }

    #[test]
    fn real_codex_signed_out_says_how_to_sign_in() {
        let mut x = codex_up();
        x.on_input(Input::send("hi")).unwrap();
        let st = replay(&mut x, &["codex-signed-out.jsonl"], &[]);
        // the retries show on the progress line instead of a silent wait
        assert!(of(&st.events, "status").iter().any(|e| s(e, "text").starts_with("Reconnecting")));
        let e = ends(&st.events);
        assert_eq!(e[0].0, "error");
        assert!(e[0].1.contains("not signed in") && !e[0].1.contains("cf-ray"), "{e:?}");
    }

    #[test]
    fn codex_mode_and_effort_go_with_every_turn() {
        let mut x = codex_up();
        // model/list as Codex 0.167 sends it on this Mac (supportedReasoningEfforts per model)
        x.call(&mut Step::default(), "model/list", json!({}));
        let (n, mid) = (x.seq, x.model_id.clone());
        run(&mut x, &[format!(r#"{{"id":{n},"result":{{"data":[{{"model":"{}","displayName":"GPT","description":"","hidden":false,"supportedReasoningEfforts":[{{"reasoningEffort":"low","description":""}},{{"reasoningEffort":"high","description":""}}]}}]}}}}"#, mid)]);
        let st = x.on_input(Input::Mode { mode: "read-only".into() }).unwrap();
        assert_eq!(s(of(&st.events, "session.info")[0], "mode"), "read-only");
        // the recorded model/list offers these efforts for the thread's model
        let model = x.model_id.clone();
        let levels = x.efforts.get(&model).cloned().unwrap();
        let level = levels.as_array().unwrap()[0].as_str().unwrap().to_string();
        x.on_input(Input::Effort { effort: level.clone() }).unwrap();
        assert!(x.on_input(Input::Effort { effort: "turbo".into() }).is_err());
        let t = written(&x.on_input(sent_with("make a file", "local-s7")).unwrap())[0].clone();
        assert_eq!(t["method"], "turn/start");
        assert_eq!(t["params"]["approvalPolicy"], "on-request");
        assert_eq!(t["params"]["sandboxPolicy"], json!({"type": "readOnly"}));
        assert_eq!(t["params"]["effort"], level.as_str());
        assert_eq!(t["params"]["clientUserMessageId"], "local-s7");
        for (mode, policy, sandbox) in [("ask", "untrusted", "workspaceWrite"), ("auto", "on-request", "workspaceWrite")] {
            x.on_input(Input::Mode { mode: mode.into() }).unwrap();
            run(&mut x, &[r#"{"method":"turn/completed","params":{"turn":{"id":"t","status":"completed"}}}"#.into()]);
            let t = written(&x.on_input(Input::send("next")).unwrap())[0].clone();
            assert_eq!((s(&t["params"], "approvalPolicy"), s(&t["params"]["sandboxPolicy"], "type")), (policy.to_string(), sandbox.to_string()));
        }
    }

    #[test]
    fn codex_reports_its_threads_mode_effort_usage_and_skills() {
        // the shapes Codex 0.167 sent on this Mac: thread/resume after a turn ran read-only, a token usage update,
        // skills/list
        let mut x = Codex::new("/w/proj", Some("01a1cad5-b3bb-7f52-9de5-0bfc4cd293f4"));
        x.start();
        let st = run(&mut x, &[
            r#"{"id":1,"result":{}}"#.into(),
            r#"{"id":2,"result":{"thread":{"id":"01a1cad5-b3bb-7f52-9de5-0bfc4cd293f4"},"model":"gpt-6.1-sol","approvalPolicy":"untrusted","sandbox":{"type":"readOnly","networkAccess":false},"reasoningEffort":"low"}}"#.into(),
        ]);
        let info = of(&st.events, "session.info")[0];
        // untrusted + readOnly is none of manut's presets: the agent's own setting, shown as such
        assert_eq!((s(info, "mode"), s(info, "effort")), ("".into(), "low".into()));
        let st = run(&mut x, &[r#"{"id":2,"result":{"thread":{"id":"t"},"model":"m","approvalPolicy":"on-request","sandbox":{"type":"readOnly"}}}"#.into()]);
        let _ = st;
        assert_eq!(codex_mode_of("on-request", "readOnly"), Some("read-only"));
        assert_eq!(codex_mode_of("never", "dangerFullAccess"), None);
        let st = run(&mut x, &[r#"{"method":"thread/tokenUsage/updated","params":{"threadId":"t","turnId":"u","tokenUsage":{"last":{"totalTokens":41250,"inputTokens":41000,"cachedInputTokens":0,"outputTokens":250,"reasoningOutputTokens":0},"total":{"totalTokens":90000,"inputTokens":1,"cachedInputTokens":0,"outputTokens":1,"reasoningOutputTokens":0},"modelContextWindow":258400}}}"#.into()]);
        assert_eq!(of(&st.events, "session.usage")[0], &json!({"event": "session.usage", "used": 41250, "max": 258400}));
        let st = run(&mut x, &[r#"{"id":4,"result":{"data":[{"cwd":"/w/proj","skills":[{"name":"review","description":"Long text","shortDescription":"Review a change","enabled":true,"path":"/home/u/.codex/skills/review/SKILL.md","scope":"user"},{"name":"off","description":"x","enabled":false,"path":"/p","scope":"user"}],"errors":[]}]}}"#.into()]);
        assert_eq!(of(&st.events, "session.commands")[0]["commands"], json!([{"name": "review", "description": "Review a change", "hint": "", "kind": "skill", "prefix": "$"}]));
        // a `$name` in the message goes with it as Codex's own skill input
        let t = written(&x.on_input(Input::send("please $review this")).unwrap())[0].clone();
        assert_eq!(t["params"]["input"][1], json!({"type": "skill", "name": "review", "path": "/home/u/.codex/skills/review/SKILL.md"}));
    }

    #[test]
    fn codex_a_message_sent_mid_turn_waits_until_codex_records_it() {
        // recorded on Codex 0.167: a second turn/start while one runs becomes a userMessage item of the same turn,
        // with our clientUserMessageId as its clientId
        let mut x = codex_up();
        x.on_input(sent_with("first", "local-s1")).unwrap();
        run(&mut x, &[r#"{"method":"turn/started","params":{"turn":{"id":"T1","status":"inProgress","items":[]}}}"#.into()]);
        let st = x.on_input(sent_with("second", "local-s2")).unwrap();
        assert_eq!(names(&st.events), ["message.queued"]);
        let st = run(&mut x, &[r#"{"method":"item/started","params":{"item":{"type":"userMessage","id":"u2","clientId":"local-s2","content":[]}}}"#.into()]);
        assert_eq!(st.events, [json!({"event": "message.taken", "id": "local-s2"})]);
        // Stop before Codex records one: it was never sent, and says so
        x.on_input(sent_with("third", "local-s3")).unwrap();
        x.on_input(Input::Interrupt).unwrap();
        let st = run(&mut x, &[r#"{"method":"turn/completed","params":{"turn":{"id":"T1","status":"interrupted"}}}"#.into()]);
        assert_eq!(names(&st.events), ["message.dropped", "turn.end"]);
        assert_eq!(st.events[0]["id"], "local-s3");
    }

    /// codex-9-helpers: the person's turn spawns two sub-agents (`write_one`, `read_first_line`); their threads'
    /// own turns, steps and answers stream on the same connection (recorded with Codex 0.167.0-alpha.3.2).
    fn codex_helpers_up() -> Codex {
        let mut x = Codex::new("/w/proj", None);
        x.start();
        run(&mut x, &real("codex-9-helpers-init.jsonl"));
        x
    }

    #[test]
    fn a_codex_helper_finishing_does_not_end_the_persons_turn() {
        let mut x = codex_helpers_up();
        x.on_input(Input::Send { text: "go".into(), images: vec![], id: String::new() }).unwrap();
        let lines = real("codex-9-helpers.jsonl");
        // the first helper's own turn/completed: the person's turn is still running
        let child_end = lines.iter().position(|l| l.contains("\"turn/completed\"") && l.contains("01a1ca24-539f")).unwrap();
        let st = run(&mut x, &lines[..=child_end]);
        assert!(x.in_turn(), "a helper's turn/completed ended the person's turn");
        assert!(!names(&st.events).contains(&"turn.end".to_string()), "{:?}", names(&st.events));
        let st = run(&mut x, &lines[child_end + 1..]);
        assert!(!x.in_turn());
        assert_eq!(names(&st.events).iter().filter(|n| *n == "turn.end").count(), 1);
        assert_eq!(st.events.iter().filter(|e| s(e, "event") == "turn.start").count(), 0, "a helper's step started a turn of its own");
    }

    #[test]
    fn a_codex_helpers_text_is_never_codexs_own_answer() {
        let mut x = codex_helpers_up();
        x.on_input(Input::Send { text: "go".into(), images: vec![], id: String::new() }).unwrap();
        let st = run(&mut x, &real("codex-9-helpers.jsonl"));
        let said = text_of(&st.events, "message");
        assert!(!said.iter().any(|t| t == "done" || t == "alpha line"), "{said:?}");
        assert!(said.iter().any(|t| t.starts_with("Agent 1 wrote one.txt")), "{said:?}");
        // no streamed helper text either (only the session's own thread's deltas), and none of the helpers'
        // commands is a step of Codex's turn
        let own = real("codex-9-helpers.jsonl").iter().filter(|l| l.contains("item/agentMessage/delta") && l.contains("\"threadId\":\"01a1ca24-1047")).count();
        assert_eq!(text_of(&st.events, "delta").len(), own);
        let steps: Vec<String> = st.events.iter().filter(|e| s(e, "event") == "tool.start").map(|e| s(e, "detail")).collect();
        assert!(!steps.iter().any(|d| d.contains("echo one") || d.contains("head -n 1")), "{steps:?}");
    }

    #[test]
    fn codex_helpers_come_out_as_subagent_lines() {
        let mut x = codex_helpers_up();
        x.on_input(Input::Send { text: "go".into(), images: vec![], id: String::new() }).unwrap();
        let st = run(&mut x, &real("codex-9-helpers.jsonl"));
        let subs: Vec<&Event> = st.events.iter().filter(|e| s(e, "event") == "subagent").collect();
        let of = |id: &str| subs.iter().filter(|e| s(e, "id").ends_with(id)).map(|e| (*e).clone()).collect::<Vec<_>>();
        let one = of("e39bedaf4545");
        let two = of("13c7f1bb6917");
        // started, its step, done with its own answer and time
        assert_eq!(one.iter().map(|e| s(e, "state")).collect::<Vec<_>>(), ["running", "running", "done"]);
        assert_eq!((s(&one[0], "agent"), s(&one[0], "name"), s(&one[0], "goal")), ("codex".into(), "write one".into(), String::new()));
        assert_eq!(s(&one[0], "model"), "gpt-6.1-sol");
        assert_eq!(s(&one[1], "step"), "echo one > one.txt");
        assert_eq!(s(&one[2], "summary"), "done");
        assert_eq!(one[2]["seconds"], json!(4.8));
        assert_eq!(s(&two[0], "name"), "read first line");
        assert_eq!(s(two.last().unwrap(), "summary"), "alpha line");
        // one fan-out of two: the same delegation (the person's turn), index 0 and 1
        let deleg = s(&one[0], "delegation");
        assert!(deleg.starts_with("codex-") && subs.iter().all(|e| s(e, "delegation") == deleg));
        assert_eq!((one[0]["index"].clone(), two[0]["index"].clone(), two[0]["count"].clone()), (json!(0), json!(1), json!(2)));
        // every subagent line comes while the person's turn runs (they belong to it)
        let end = st.events.iter().position(|e| s(e, "event") == "turn.end").unwrap();
        assert!(st.events.iter().rposition(|e| s(e, "event") == "subagent").unwrap() < end);
    }

    #[test]
    fn codex_stop_while_a_helper_runs_names_the_persons_turn() {
        // codex-10: one helper runs `sleep 45`; the person presses Stop while it runs
        let mut x = Codex::new("/w/proj", None);
        x.start();
        run(&mut x, &real("codex-10-helper-stop-init.jsonl"));
        x.on_input(Input::Send { text: "go".into(), images: vec![], id: String::new() }).unwrap();
        run(&mut x, &real("codex-10-helper-stop.jsonl"));
        let st = x.on_input(Input::Interrupt).unwrap();
        let w = written(&st);
        assert_eq!(w[0]["method"], "turn/interrupt");
        // the session's own thread and turn, not the helper's (`…fa6d…`, which Codex refuses)
        assert_eq!(w[0]["params"]["threadId"], "01a1ca32-da48-7f42-adc1-3469420bbfa8");
        assert_eq!(w[0]["params"]["turnId"], "01a1ca32-e30e-7312-bc08-818ebbf0e1b3");
        // the recording holds Codex's refusal of the old (helper's) id: a refused Stop shows on the turn's line
        let st = run(&mut x, &real("codex-10-helper-stopped.jsonl")[..1]);
        assert_eq!(names(&st.events), ["status"]);
        assert!(s(&st.events[0], "text").starts_with("Codex did not stop: expected active turn id"));
        // the helper's message is its summary, not Codex's
        let st = run(&mut x, &real("codex-10-helper-stopped.jsonl")[1..]);
        let said = text_of(&st.events, "message");
        assert_eq!(said.len(), 1, "{said:?}");
        assert!(said[0].starts_with("The sub-agent completed"));
        assert_eq!(names(&st.events).last().unwrap(), "turn.end");
    }

    #[test]
    fn an_ask_inside_a_codex_helper_names_the_helper() {
        // shape from codex-rs app-server-protocol (v2 CommandExecutionRequestApprovalParams); this Mac's Codex runs
        // with approval_policy = never, so no helper approval was recorded
        let mut x = codex_helpers_up();
        x.on_input(Input::Send { text: "go".into(), images: vec![], id: String::new() }).unwrap();
        let lines = real("codex-9-helpers.jsonl");
        let spawned = lines.iter().position(|l| l.contains("\"subAgentActivity\"") && l.contains("write_one")).unwrap();
        run(&mut x, &lines[..=spawned]);
        let st = x.on_line(r#"{"id":91,"method":"item/commandExecution/requestApproval","params":{"threadId":"01a1ca24-539f-7e51-ad88-e39bedaf4545","turnId":"01a1ca24-53f9-72c0-a436-7edf958315cf","itemId":"exec-1","command":"/bin/zsh -lc 'rm one.txt'","cwd":"/w/proj"}}"#);
        assert_eq!(s(&st.events[0], "event"), "approval.request");
        assert_eq!(st.events[0]["subagent"], json!({"id": "01a1ca24-539f-7e51-ad88-e39bedaf4545", "name": "write one"}));
        // the answer goes back to the same request
        let st = x.on_input(Input::Approve { request_id: "codex-91".into(), choice: "deny".into() }).unwrap();
        assert_eq!(written(&st)[0], json!({"id": 91, "result": {"decision": "decline"}}));
        // an ask on the session's own thread names no helper
        let st = x.on_line(r#"{"id":92,"method":"item/commandExecution/requestApproval","params":{"threadId":"01a1ca24-1047-7ee0-aac2-faf093d44dbe","turnId":"t","itemId":"exec-2","command":"ls"}}"#);
        assert!(st.events[0].get("subagent").is_none());
    }

    #[test]
    fn a_codex_helpers_ask_outlives_the_persons_turn_while_the_helper_runs() {
        // not observed on this Mac (its Codex runs with approval: never): a helper still running when the person's
        // turn completes keeps its approval answerable, as Claude Code's background subagents do; the turn's own
        // approval does not
        let mut x = codex_helpers_up();
        x.on_input(Input::Send { text: "go".into(), images: vec![], id: String::new() }).unwrap();
        let lines = real("codex-9-helpers.jsonl");
        let spawned = lines.iter().position(|l| l.contains("\"subAgentActivity\"") && l.contains("write_one")).unwrap();
        run(&mut x, &lines[..=spawned]);
        x.on_line(r#"{"id":91,"method":"item/commandExecution/requestApproval","params":{"threadId":"01a1ca24-539f-7e51-ad88-e39bedaf4545","turnId":"01a1ca24-53f9-72c0-a436-7edf958315cf","itemId":"exec-1","command":"rm one.txt","cwd":"/w/proj"}}"#);
        x.on_line(r#"{"id":92,"method":"item/commandExecution/requestApproval","params":{"threadId":"01a1ca24-1047-7ee0-aac2-faf093d44dbe","turnId":"t","itemId":"exec-2","command":"ls"}}"#);
        let st = x.on_line(r#"{"method":"turn/completed","params":{"threadId":"01a1ca24-1047-7ee0-aac2-faf093d44dbe","turn":{"id":"t","status":"completed","items":[]}}}"#);
        assert_eq!(ends(&st.events), [("done".into(), "".into())]);
        assert_eq!(written(&x.on_input(Input::Approve { request_id: "codex-91".into(), choice: "once".into() }).unwrap())[0], json!({"id": 91, "result": {"decision": "accept"}}));
        assert!(x.on_input(Input::Approve { request_id: "codex-92".into(), choice: "once".into() }).is_err());
    }

    #[test]
    fn codex_stop_before_the_turn_has_an_id_still_stops_it() {
        // before the thread exists the message only waits: Stop drops it and ends the turn
        let mut x = Codex::new("/w/proj", None);
        x.start();
        x.on_input(Input::Send { text: "hi".into(), images: vec![], id: String::new() }).unwrap();
        let st = x.on_input(Input::Interrupt).unwrap();
        assert_eq!(st.events, [json!({"event": "turn.end", "outcome": "interrupted"})]);
        assert!(!x.in_turn() && run(&mut x, &real("codex-init.jsonl")).write.iter().all(|w| !w.contains("turn/start")));
        // sent, but Codex has not named the turn yet: Stop waits for the name, then interrupts it
        let mut x = codex_up();
        x.on_input(Input::Send { text: "sleep".into(), images: vec![], id: String::new() }).unwrap();
        assert!(x.on_input(Input::Interrupt).unwrap().write.is_empty());
        let st = x.on_line(r#"{"method":"turn/started","params":{"threadId":"t","turn":{"id":"turn_7","status":"inProgress","items":[]}}}"#);
        assert_eq!(written(&st)[0]["method"], "turn/interrupt");
        assert_eq!(written(&st)[0]["params"]["turnId"], "turn_7");
        // an error outside a turn is a note, not a progress line
        let mut idle = codex_up();
        let st = idle.on_line(r#"{"method":"error","params":{"error":{"message":"boom"},"willRetry":false}}"#);
        assert_eq!(names(&st.events), ["session.error"]);
        assert!(idle.on_line(r#"{"method":"error","params":{"error":{"message":"Reconnecting... 1/5"},"willRetry":true}}"#).events.is_empty());
    }

    #[test]
    fn codex_gets_pictures_as_local_image_items_even_when_queued_before_the_thread() {
        let mut x = codex_up();
        let st = x.on_input(with_pic("What does it say?")).unwrap();
        let t: Value = serde_json::from_str(st.write.last().unwrap()).unwrap();
        assert_eq!(t["method"], "turn/start");
        assert_eq!(t["params"]["input"], json!([{"type": "localImage", "path": "/h/.manut/session-files/s1/1-word.png"}, {"type": "text", "text": "What does it say?"}]));
        // sent before the thread exists: the picture waits with the text
        let mut x = Codex::new("/w/proj", None);
        x.start();
        assert!(x.on_input(with_pic("")).unwrap().write.is_empty());
        let st = run(&mut x, &real("codex-init.jsonl"));
        let t: Value = st.write.iter().map(|w| serde_json::from_str::<Value>(w).unwrap()).find(|v| v["method"] == "turn/start").unwrap();
        assert_eq!(t["params"]["input"], json!([{"type": "localImage", "path": "/h/.manut/session-files/s1/1-word.png"}]));
    }

    #[test]
    fn codex_plan_reasoning_and_file_changes_come_out_in_the_same_shapes() {
        // shapes from codex-rs app-server-protocol v2 (codex 0.167 `generate-ts`): turn/plan/updated, reasoning
        // summary and raw deltas, a fileChange update with a unified diff; Codex has no credit on this Mac, so the
        // turn is built from the schema, the item/started of a real fileChange (codex-3-edit) is real
        let mut x = codex_up();
        x.on_input(Input::send("go")).unwrap();
        let t = r#"{"method":"turn/started","params":{"threadId":"01a1c3b9-4b7f-7542-900c-c5f4dc80eefa","turn":{"id":"t9","items":[],"status":"inProgress"}}}"#;
        let plan = r#"{"method":"turn/plan/updated","params":{"threadId":"01a1c3b9-4b7f-7542-900c-c5f4dc80eefa","turnId":"t9","explanation":null,"plan":[{"step":"Add mul to calc.py","status":"completed"},{"step":"List functions in README.md","status":"inProgress"},{"step":"Run a check","status":"pending"}]}}"#;
        let sum = r#"{"method":"item/reasoning/summaryTextDelta","params":{"threadId":"01a1c3b9-4b7f-7542-900c-c5f4dc80eefa","turnId":"t9","itemId":"rs1","delta":"Two files to touch.","summaryIndex":0}}"#;
        let raw = r#"{"method":"item/reasoning/textDelta","params":{"threadId":"01a1c3b9-4b7f-7542-900c-c5f4dc80eefa","turnId":"t9","itemId":"rs1","delta":"raw","contentIndex":0}}"#;
        let raw2 = r#"{"method":"item/reasoning/textDelta","params":{"threadId":"01a1c3b9-4b7f-7542-900c-c5f4dc80eefa","turnId":"t9","itemId":"rs2","delta":"only raw","contentIndex":0}}"#;
        let fc = r##"{"method":"item/started","params":{"threadId":"01a1c3b9-4b7f-7542-900c-c5f4dc80eefa","turnId":"t9","item":{"type":"fileChange","id":"fc1","status":"inProgress","changes":[{"path":"/w/proj/calc.py","kind":{"type":"update","move_path":null},"diff":"--- a/calc.py\n+++ b/calc.py\n@@ -5,2 +5,5 @@\n def sub(a, b):\n     return a - b\n+\n+def mul(a, b):\n+    return a * b\n"},{"path":"/w/proj/README.md","kind":{"type":"add"},"diff":"# calc\nFunctions: add, sub, mul\n"}]}}}"##;
        let st = run(&mut x, &[t.into(), plan.into(), sum.into(), raw.into(), raw2.into(), fc.into()]);
        let p = of_kind(&st.events, "plan");
        assert_eq!(p[0]["items"], json!([{"text": "Add mul to calc.py", "status": "completed"}, {"text": "List functions in README.md", "status": "in_progress"}, {"text": "Run a check", "status": "pending"}]));
        let th: Vec<String> = of_kind(&st.events, "thinking").iter().map(|e| s(e, "text")).collect();
        assert_eq!(th, ["Two files to touch.", "", "only raw"], "a summarized item's raw text is not shown twice");
        let d = of_kind(&st.events, "tool.diff");
        assert_eq!(s(d[0], "tool_id"), "fc1");
        let f = d[0]["files"].as_array().unwrap();
        assert_eq!((s(&f[0], "path"), s(&f[0], "kind")), ("calc.py".into(), "update".into()));
        assert_eq!(f[0]["lines"][0], "@@ -5,2 +5,5 @@");
        assert_eq!((f[0]["added"].as_u64(), f[0]["removed"].as_u64()), (Some(3), Some(0)));
        assert_eq!((s(&f[1], "kind"), f[1]["lines"].clone()), ("add".into(), json!(["+# calc", "+Functions: add, sub, mul"])));
        // a real recording (codex-3-edit): the new file's content is its change
        let mut x = codex_up();
        x.on_input(Input::send("go")).unwrap();
        let st = run(&mut x, &real("codex-3-edit.jsonl"));
        let d = of_kind(&st.events, "tool.diff");
        assert!(!d.is_empty());
        assert_eq!(d[0]["files"][0]["lines"], json!(["+hello from qa"]));
    }

    #[test]
    fn codex_rewind_reverts_the_thread_before_the_last_turn() {
        // thread/revert {threadId, beforeTurnId} answered and followed by thread/reverted, as Codex 0.167 did in a
        // scratch thread (two failed turns, no credit; the revert itself needs none)
        let mut x = codex_up();
        assert!(x.on_input(Input::Rewind).is_err());
        x.on_input(Input::send("go")).unwrap();
        run(&mut x, &real("codex-1-plain.jsonl"));
        let st = x.on_input(Input::Rewind).unwrap();
        let w = written(&st);
        assert_eq!(s(&w[0], "method"), "thread/revert");
        assert_eq!(w[0]["params"]["threadId"], json!("01a1c3b9-4b7f-7542-900c-c5f4dc80eefa"));
        assert!(!s(&w[0]["params"], "beforeTurnId").is_empty());
        let id = w[0]["id"].as_u64().unwrap();
        let st = x.on_line(&format!(r#"{{"id":{id},"result":{{"thread":{{"id":"01a1c3b9-4b7f-7542-900c-c5f4dc80eefa"}},"turnsBackwardsCursor":null,"itemsBackwardsCursor":null}}}}"#));
        assert_eq!(st.events, vec![json!({"event": "rewound"}), json!({"event": "session.info", "rewind": false})]);
        assert!(x.on_input(Input::Rewind).is_err(), "nothing left to take back");
    }

    #[test]
    fn codex_steer_is_its_own_turn_steer_on_the_running_turn() {
        let mut x = codex_up();
        x.on_input(sent_with("first", "local-s1")).unwrap();
        run(&mut x, &[r#"{"method":"turn/started","params":{"turn":{"id":"T1","status":"inProgress","items":[]}}}"#.into()]);
        let st = x.on_input(steer("also the docs", "local-s2")).unwrap();
        // manut held it: no second "queued", and the frame is app-server's TurnSteerParams (codex 0.169 schema)
        assert!(st.events.is_empty());
        let w = written(&st);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0]["method"], "turn/steer");
        let thread = x.thread.clone().unwrap();
        assert_eq!(w[0]["params"], json!({"threadId": thread, "input": [{"type": "text", "text": "also the docs"}], "expectedTurnId": "T1", "clientUserMessageId": "local-s2"}));
        // Codex records it in the same turn: taken
        let st = run(&mut x, &[r#"{"method":"item/started","params":{"item":{"type":"userMessage","id":"u2","clientId":"local-s2","content":[]}}}"#.into()]);
        assert_eq!(st.events, [json!({"event": "message.taken", "id": "local-s2"})]);
        // its request answered: nothing kept for it
        let n = w[0]["id"].as_u64().unwrap();
        run(&mut x, &[format!(r#"{{"id":{n},"result":{{"turnId":"T1"}}}}"#)]);
        assert!(x.steers.is_empty());
        // a steer Codex refuses (the turn moved on) never reached it, and says so
        let st = x.on_input(steer("late", "local-s3")).unwrap();
        let n = written(&st)[0]["id"].as_u64().unwrap();
        let st = run(&mut x, &[format!(r#"{{"id":{n},"error":{{"code":-32600,"message":"expected turn T1 is not active"}}}}"#)]);
        assert_eq!(names(&st.events), ["message.dropped", "status"]);
        assert_eq!(st.events[0]["id"], "local-s3");
        // no turn: nothing to steer
        run(&mut x, &[r#"{"method":"turn/completed","params":{"turn":{"id":"T1","status":"completed"}}}"#.into()]);
        assert!(x.on_input(steer("x", "local-s4")).is_err());
    }

    #[test]
    fn send_now_is_one_stop_then_the_held_message_goes_first() {
        // manut held "B" and "C"; Send now on C: Stop, and after the stopped turn's end C goes out before B
        let mut x = codex_up();
        x.on_input(sent_with("A", "s1")).unwrap();
        run(&mut x, &[r#"{"method":"turn/started","params":{"turn":{"id":"T1","status":"inProgress","items":[]}}}"#.into()]);
        let w = written(&x.on_input(Input::Interrupt).unwrap());
        assert_eq!(w.iter().map(|v| s(v, "method")).collect::<Vec<_>>(), ["turn/interrupt"]);
        let st = run(&mut x, &[r#"{"method":"turn/completed","params":{"turn":{"id":"T1","status":"interrupted"}}}"#.into()]);
        // nothing was handed to Codex while it ran, so nothing is dropped
        assert_eq!(names(&st.events), ["turn.end"]);
        let mut order = vec![];
        for (text, id) in [("C", "s3"), ("B", "s2")] {
            let st = x.on_input(sent_with(text, id)).unwrap();
            assert!(of(&st.events, "message.queued").is_empty(), "{text} starts its own turn");
            let w = written(&st);
            order.push(w[0]["params"]["input"][0]["text"].as_str().unwrap().to_string());
            run(&mut x, &[r#"{"method":"turn/completed","params":{"turn":{"id":"T2","status":"completed"}}}"#.into()]);
        }
        assert_eq!(order, ["C", "B"]);
    }

    #[test]
    fn a_codex_command_the_person_declined_says_so_and_a_file_change_sends_no_output() {
        let mut x = Codex::new("/w", None);
        x.start();
        run(&mut x, &fixture("codex-turn.jsonl")[..2]);
        x.on_input(Input::send("go")).unwrap();
        x.on_line(r#"{"method":"turn/started","params":{"threadId":"thr_1","turn":{"id":"turn_9","status":"inProgress","items":[]}}}"#);
        let mut done = |item: Value| x.on_line(&json!({"method": "item/completed", "params": {"threadId": "thr_1", "turnId": "turn_9", "item": item}}).to_string());
        let st = done(json!({"type": "commandExecution", "id": "c1", "command": "pnpm test", "status": "declined", "aggregatedOutput": "", "exitCode": null}));
        let end = &of(&st.events, "tool.end")[0];
        assert_eq!((end["ok"].clone(), end["declined"].clone()), (json!(false), json!(true)));
        assert!(end.get("output").is_none());
        let st = done(json!({"type": "commandExecution", "id": "c2", "command": "/bin/zsh -lc 'cd /w && pnpm test'", "status": "failed", "aggregatedOutput": "Tests  1 failed (1)\n", "exitCode": 1}));
        let end = &of(&st.events, "tool.end")[0];
        assert_eq!((end["ok"].clone(), end["output"].clone()), (json!(false), json!("Tests  1 failed (1)\n")));
        // the command is the script inside Codex's shell wrapper, as the person would type it
        assert_eq!(end["command"], "cd /w && pnpm test");
        let st = done(json!({"type": "mcpToolCall", "id": "c3", "status": "completed", "aggregatedOutput": "not for the page"}));
        assert!(of(&st.events, "tool.end")[0].get("output").is_none());
    }
}
