//! What every adapter reports about its work, in one agent-neutral shape: subagent rows (`Subagents`), the
//! detail line of a tool call, the diff cards of an edit, the way a program's exit is worded, and the ask cards
//! (permission and question) that the Claude Code, Codex and pi adapters all draw. These live apart from the
//! adapters so that a step, a diff or an ended turn reads the same on the page whichever agent ran it, and so a
//! change to that wording is made once.

use super::*;

// ---------------------------------------------------------------------------------------------
// Subagents: one agent-neutral event for every agent
// ---------------------------------------------------------------------------------------------

/// The subagents a session's agent started, as ONE event shape whatever the agent (Claude Code's Agent/Task tool,
/// Codex sub-agent threads, OmO's `task`; later any ACP agent): `{"event": "subagent", id, agent, name, goal,
/// delegation, index, count, state, model?, tool?, step?, summary?, seconds?}`. `id` is stable for the subagent
/// (a later event with the same id updates its row); `delegation` groups the subagents started together (one fan-out);
/// `state` is queued | running | thinking | done | failed | cancelled. manut only shows these: it never assigns,
/// steers or stops a subagent.
#[derive(Default)]
pub(super) struct Subagents {
    agent: &'static str,
    pub(super) subs: HashMap<String, Sub>,
    /// the fan-out filling now: its key and how many it has
    fanout: (String, usize),
}

pub(super) struct Sub {
    pub(super) name: String,
    pub(super) goal: String,
    pub(super) model: String,
    delegation: String,
    index: usize,
    /// its last message so far: its answer when it ends without one of its own
    pub(super) text: String,
    ended: bool,
}

impl Subagents {
    pub(super) fn new(agent: &'static str) -> Subagents {
        Subagents { agent, ..Subagents::default() }
    }
    pub(super) fn has(&self, id: &str) -> bool {
        self.subs.contains_key(id)
    }
    /// Registers `id` in fan-out `delegation` (a new key starts a new fan-out), or returns it as it is.
    pub(super) fn add(&mut self, id: &str, delegation: &str, name: &str, goal: &str, model: &str) -> &mut Sub {
        if !self.subs.contains_key(id) {
            if self.fanout.0 != delegation {
                self.fanout = (delegation.to_string(), 0);
            }
            let index = self.fanout.1;
            self.fanout.1 += 1;
            self.subs.insert(id.to_string(), Sub { name: clip(name, 80), goal: clip(goal, 160), model: String::new(), delegation: delegation.to_string(), index, text: String::new(), ended: false });
        }
        let s = self.subs.get_mut(id).unwrap();
        if !model.is_empty() {
            s.model = model.to_string();
        }
        if s.goal.is_empty() && !goal.is_empty() {
            s.goal = clip(goal, 160);
        }
        s
    }
    /// The event for `id` in `state`, with `extra` fields (tool, step, summary, seconds). Unknown ids give none.
    pub(super) fn event(&self, id: &str, state: &str, extra: Value) -> Option<Event> {
        let s = self.subs.get(id)?;
        let count = if self.fanout.0 == s.delegation { self.fanout.1 } else { s.index + 1 };
        let mut f = json!({"id": id, "agent": self.agent, "name": s.name, "goal": s.goal, "delegation": s.delegation, "index": s.index, "count": count, "state": state});
        if !s.model.is_empty() {
            f["model"] = Value::String(s.model.clone());
        }
        if let (Value::Object(m), Value::Object(x)) = (&mut f, extra) {
            m.extend(x.into_iter().filter(|(_, v)| !v.is_null() && v.as_str() != Some("")));
        }
        Some(ev("subagent", f))
    }
    /// The subagents not yet ended, in the order they started.
    pub(super) fn open(&self) -> Vec<String> {
        let mut v: Vec<(&String, &Sub)> = self.subs.iter().filter(|(_, s)| !s.ended).collect();
        v.sort_by(|a, b| (&a.1.delegation, a.1.index).cmp(&(&b.1.delegation, b.1.index)));
        v.into_iter().map(|(k, _)| k.clone()).collect()
    }
    /// A step the subagent runs now.
    pub(super) fn step(&self, st: &mut Step, id: &str, tool: &str, step: &str) {
        st.events.extend(self.event(id, "running", json!({"tool": tool, "step": clip(step, 120)})));
    }
    /// A file edit the subagent runs now, with its change per file (`tool.diff`'s shape): the row's step opens to it.
    /// Said again with the same step when the edit has run, so the change shown is what it finally was.
    pub(super) fn edit(&self, st: &mut Step, id: &str, step: &str, files: Vec<Value>) {
        st.events.extend(self.event(id, "running", json!({"tool": "patch", "step": clip(step, 120), "diff": files})));
    }
    /// Ends `id` once: done (its answer, else its last message), failed (the error) or cancelled.
    pub(super) fn end(&mut self, st: &mut Step, id: &str, state: &str, answer: &str, secs: Option<f64>) {
        let Some(s) = self.subs.get_mut(id) else { return };
        if s.ended {
            return;
        }
        s.ended = true;
        let text = if answer.trim().is_empty() { s.text.clone() } else { answer.to_string() };
        // one plain line: a fenced answer ("```\nalpha line\n```") reads as its text
        let mut f = json!({"summary": clip(&text.replace("```", " "), 200)});
        if let Some(x) = secs {
            f["seconds"] = json!((x * 10.0).round() / 10.0);
        }
        st.events.extend(self.event(id, state, f));
    }
}

/// The ask (approval or question) events in `st` from index `from` on carry who asked: `subagent: {id, name}`.
pub(super) fn tag_asks(st: &mut Step, from: usize, id: &str, name: &str) {
    for e in &mut st.events[from..] {
        if matches!(s(e, "event").as_str(), "approval.request" | "clarify.request") {
            e["subagent"] = json!({"id": id, "name": name});
        }
    }
}

/// A conversation name an agent reported, as the session row shows it: one line, at most 80 characters.
pub(super) fn title_of(t: &str) -> String {
    let t: String = t.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    clip(t.trim(), 80)
}

/// `path` relative to the session folder when it is inside it (agents report absolute paths).
pub(super) fn rel(path: &str, cwd: &str) -> String {
    let c = cwd.trim_end_matches(['/', '\\']);
    if !c.is_empty() {
        for sep in ['/', '\\'] {
            if let Some(r) = path.strip_prefix(&format!("{c}{sep}")) {
                return r.to_string();
            }
        }
    }
    path.to_string()
}

pub(super) fn lines_of(t: &str) -> u64 {
    t.lines().count() as u64
}

/// `+a` / `-d` counts of a unified diff (headers skipped).
pub(super) fn unified_counts(diff: &str) -> (u64, u64) {
    let (mut a, mut d) = (0, 0);
    for l in diff.lines() {
        if l.starts_with("+++") || l.starts_with("---") {
            continue;
        }
        if l.starts_with('+') {
            a += 1;
        } else if l.starts_with('-') {
            d += 1;
        }
    }
    (a, d)
}

/// One line for a file change: `notes.txt +1`, `a.ts +3 -1, b.ts +1`.
pub(super) fn edit_detail(files: &[(String, u64, u64)]) -> String {
    let parts: Vec<String> = files
        .iter()
        .map(|(p, a, d)| {
            let mut x = p.clone();
            if *a > 0 {
                x.push_str(&format!(" +{a}"));
            }
            if *d > 0 {
                x.push_str(&format!(" -{d}"));
            }
            x
        })
        .collect();
    clip(&parts.join(", "), 160)
}

/// How many lines of one file's change the diff view gets, and how long one line may be. The rest is counted
/// (`more`), never sent.
pub(super) const DIFF_LINES: usize = 400;
const DIFF_LINE_CHARS: usize = 2000;

/// The text's lines (a trailing newline ends the last line, it does not start an empty one).
fn text_lines(t: &str) -> Vec<&str> {
    if t.is_empty() {
        return vec![];
    }
    t.strip_suffix('\n').unwrap_or(t).split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect()
}

/// One file's change for the diff view (`tool.diff`), in one agent-neutral shape: `lines` start with `+`, `-`,
/// ` ` (context) or `@@` (a hunk), at most [`DIFF_LINES`] of them; `added` / `removed` count every line.
pub(crate) fn diff_file(path: &str, kind: &str, lines: Vec<String>) -> Value {
    let added = lines.iter().filter(|l| l.starts_with('+')).count();
    let removed = lines.iter().filter(|l| l.starts_with('-')).count();
    let more = lines.len().saturating_sub(DIFF_LINES);
    let kept: Vec<String> = lines.into_iter().take(DIFF_LINES).map(|l| if l.chars().count() > DIFF_LINE_CHARS { l.chars().take(DIFF_LINE_CHARS).collect() } else { l }).collect();
    let mut f = json!({"path": path, "kind": kind, "lines": kept, "added": added, "removed": removed});
    if more > 0 {
        f["more"] = json!(more);
    }
    f
}

/// `prefix` before every line of `t`.
fn marked(prefix: char, t: &str) -> Vec<String> {
    text_lines(t).into_iter().map(|l| format!("{prefix}{l}")).collect()
}

/// The change a file tool call asks for, from its input alone: Claude Code `Write {file_path, content}` /
/// `Edit {file_path, old_string, new_string}` / `MultiEdit {file_path, edits}`, pi `write {path, content}` /
/// `edit {path, edits:[{oldText,newText}]}`. `None` for anything else (oh-my-pi's hashline edit has no plain text).
pub(crate) fn input_diff(name: &str, input: &Value, cwd: &str) -> Option<Value> {
    if tool_kind(name) != "patch" {
        return None;
    }
    let path = ["file_path", "path", "notebook_path"].iter().map(|k| s(input, k)).find(|p| !p.is_empty())?;
    let mut lines = Vec::new();
    let mut kind = "update";
    if let Some(c) = input.get("content").and_then(Value::as_str) {
        kind = "add";
        lines.extend(marked('+', c));
    }
    let pair = |old: &str, new: &str, lines: &mut Vec<String>| {
        if !lines.is_empty() {
            lines.push("@@".into());
        }
        lines.extend(marked('-', old));
        lines.extend(marked('+', new));
    };
    if input.get("old_string").is_some() || input.get("new_string").is_some() {
        pair(&s(input, "old_string"), &s(input, "new_string"), &mut lines);
    }
    for e in input.get("edits").and_then(Value::as_array).into_iter().flatten() {
        let old = if e.get("old_string").is_some() { s(e, "old_string") } else { s(e, "oldText") };
        let new = if e.get("new_string").is_some() { s(e, "new_string") } else { s(e, "newText") };
        pair(&old, &new, &mut lines);
    }
    if lines.is_empty() {
        return None;
    }
    Some(diff_file(&rel(&path, cwd), kind, lines))
}

/// The change Claude Code made, from its tool result (`structuredPatch` hunks with context, or a new file's
/// content): what the diff view shows once the edit ran.
pub(super) fn claude_result_diff(tur: &Value, cwd: &str) -> Option<Value> {
    let path = s(tur, "filePath");
    if path.is_empty() {
        return None;
    }
    let hunks = tur.get("structuredPatch").and_then(Value::as_array).filter(|h| !h.is_empty());
    if let Some(hunks) = hunks {
        let mut lines = Vec::new();
        for h in hunks {
            let n = |k: &str| h.get(k).and_then(Value::as_u64).unwrap_or(0);
            lines.push(format!("@@ -{},{} +{},{} @@", n("oldStart"), n("oldLines"), n("newStart"), n("newLines")));
            lines.extend(h.get("lines").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(String::from));
        }
        return Some(diff_file(&rel(&path, cwd), if s(tur, "type") == "create" { "add" } else { "update" }, lines));
    }
    if s(tur, "type") == "create" {
        return Some(diff_file(&rel(&path, cwd), "add", marked('+', &s(tur, "content"))));
    }
    None
}

/// The files of a Codex `fileChange` item: an added file's diff is its content, a deleted one's its old content,
/// an update's a unified diff (its `---` / `+++` headers dropped).
pub(super) fn codex_diff(item: &Value, cwd: &str) -> Vec<Value> {
    item.get("changes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|c| !s(c, "path").is_empty())
        .map(|c| {
            let diff = s(c, "diff");
            let kind = c.get("kind").map(|k| s(k, "type")).unwrap_or_default();
            let (kind, lines) = match kind.as_str() {
                "add" => ("add", marked('+', &diff)),
                "delete" => ("delete", marked('-', &diff)),
                _ => (
                    "update",
                    text_lines(&diff)
                        .into_iter()
                        .filter(|l| !(l.starts_with("+++") || l.starts_with("---") || l.starts_with("diff --git") || l.starts_with("index ")))
                        .map(String::from)
                        .collect(),
                ),
            };
            diff_file(&rel(&s(c, "path"), cwd), kind, lines)
        })
        .collect()
}

/// A `plan` event: the agent's own todo list as it stands now, `status` pending | in_progress | completed.
pub(crate) fn plan_event(items: &[(String, String)]) -> Event {
    let items: Vec<Value> = items.iter().filter(|(t, _)| !t.trim().is_empty()).map(|(t, st)| json!({"text": clip(t, 200), "status": st})).collect();
    ev("plan", json!({"items": items}))
}

/// A `thinking` event, with the text the agent sent (none when it sends only a marker).
pub(crate) fn thinking_event(text: &str) -> Event {
    if text.is_empty() {
        ev("thinking", json!({}))
    } else {
        ev("thinking", json!({"text": text}))
    }
}

/// The command a shell wrapper runs: `/bin/zsh -lc 'mkdir -p d1'` -> `mkdir -p d1` (Codex reports the
/// wrapped form). Anything else comes back as it is.
pub(super) fn unwrap_shell(cmd: &str) -> String {
    let t = cmd.trim();
    let Some((prog, rest)) = t.split_once(' ') else { return t.to_string() };
    let base = prog.rsplit(['/', '\\']).next().unwrap_or(prog);
    if !matches!(base, "sh" | "bash" | "zsh") {
        return t.to_string();
    }
    let rest = rest.trim_start();
    let Some((flag, body)) = rest.split_once(' ') else { return t.to_string() };
    if !matches!(flag, "-c" | "-lc" | "-lic" | "-ic") {
        return t.to_string();
    }
    let body = body.trim();
    if body.len() >= 2 && body.starts_with('\'') && body.ends_with('\'') {
        return body[1..body.len() - 1].replace("'\\''", "'");
    }
    if body.len() >= 2 && body.starts_with('"') && body.ends_with('"') {
        return body[1..body.len() - 1].replace("\\\"", "\"");
    }
    body.to_string()
}

/// How a turn ends when its program exits in the middle of it: a clean exit (code 0, nothing on stderr) is
/// "ended", which the UI shows in grey; any other exit is an "error" carrying the reason.
pub(crate) fn exit_turn_end(code: Option<i32>, err: &str) -> Value {
    if code == Some(0) && err.is_empty() {
        return ev("turn.end", json!({"outcome": "ended"}));
    }
    let e = if err.is_empty() { "the agent stopped" } else { err };
    ev("turn.end", json!({"outcome": "error", "error": e}))
}

/// The useful lines of what a program wrote to stderr, in order: colour codes removed; warnings dropped
/// (`Warning: …`, `note: …`, a `WARN`/`INFO` log line, Codex's "ignoring 1 unrecognized configuration setting"), and
/// so are indented lines (the file a start-up warning names under it, a stack's frames, a list under a heading) and
/// help text (`Usage: …`, "For more information …", a heading ending in `:`). Each is at most 200 characters.
fn exit_lines(tail: &str) -> Vec<String> {
    let is_log = |l: &str| l.len() > 11 && l.as_bytes()[..4].iter().all(u8::is_ascii_digit) && l.as_bytes()[4] == b'-' && l.as_bytes()[10] == b'T';
    let skip = |l: &str| {
        let low = l.to_ascii_lowercase();
        low.starts_with("warning:")
            || low.starts_with("warn:")
            || low.starts_with("note:")
            || (is_log(l) && [" WARN ", " INFO ", " DEBUG ", " TRACE "].iter().any(|w| l.contains(w)))
            || low.contains("unrecognized configuration setting")
            || low.starts_with("usage:")
            || low.starts_with("for more information")
            || l.ends_with(':')
    };
    tail.lines().map(strip_ansi).filter(|l| !l.starts_with([' ', '\t'])).map(|l| l.trim().to_string()).filter(|l| !l.is_empty() && !skip(l)).map(|l| clip(&l, 200)).collect()
}

/// The reason in a program's stderr: its last useful line ([`exit_lines`]), else nothing.
pub(crate) fn exit_reason(tail: &str) -> String {
    exit_lines(tail).pop().unwrap_or_default()
}

/// What an exit's stderr says about why the program failed, for [`Adapter::explain`]: every useful line, so a
/// sign-in hint anywhere in it is found (the reason shown is the last one). Nothing when the program ended with
/// code 0: an orderly close, where a warning it printed at start is not why it ended.
pub(crate) fn exit_why(code: Option<i32>, tail: &str) -> String {
    if code == Some(0) {
        String::new()
    } else {
        exit_lines(tail).join("\n")
    }
}

/// The last non-empty line of `text`.
pub(crate) fn last_line(text: &str) -> &str {
    text.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("")
}

/// The protocol messages on one line of an agent's stdout, in order: a leading byte-order mark is dropped, and a line
/// holding two JSON objects back to back (`{…}{…}`, a missed newline) yields both. A line that does not start with a
/// JSON object (a banner, a terminal frame) yields nothing; after a bad value the rest of the line is dropped.
pub(crate) fn protocol_lines(line: &str) -> Vec<&str> {
    let line = line.trim_start_matches('\u{feff}');
    let mut out = Vec::new();
    let mut values = serde_json::Deserializer::from_str(line).into_iter::<serde::de::IgnoredAny>();
    let mut from = 0;
    while let Some(Ok(_)) = values.next() {
        let to = values.byte_offset();
        let one = line[from..to].trim();
        if !one.starts_with('{') {
            break;
        }
        out.push(one);
        from = to;
    }
    out
}

/// How long a chat's program has to print its first protocol message. Measured on this Mac (load about 4.5) from
/// start to the first JSON line: Claude Code 0.25 s, Codex 0.11-0.29 s, OmO 0.71-1.48 s. 20 s leaves a slow first
/// start (a cold disk, an antivirus scan of node on Windows) more than ten times the slowest of those.
pub(crate) const START_DEADLINE: Duration = Duration::from_secs(20);

/// The reason a session ends with when its program never spoke its chat protocol: an old version that does not know
/// the structured mode, or a start that hangs. The UI shows its own words for it (with the install line); this text
/// is what reaches the session when it has none.
pub(crate) fn no_chat_mode(agent: &str) -> String {
    format!("{agent} did not answer in chat mode; it may be an old version: update it, then Restart.")
}

/// Whether `reason` (an exit's stderr) says the program refused manut's chat-mode arguments (`--mode rpc`,
/// `app-server`, `--input-format` …): a version that does not have the mode.
pub(crate) fn refused_chat_mode(reason: &str) -> bool {
    let low = reason.to_ascii_lowercase();
    ["unknown option", "unknown argument", "unexpected argument", "unrecognized option", "unrecognized argument", "invalid option", "unknown command", "unrecognized subcommand"]
        .iter()
        .any(|p| low.contains(p))
}

/// `text` without terminal colour and cursor codes (`ESC [ … letter`).
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut it = text.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\u{1b}' {
            if it.peek() == Some(&'[') {
                it.next();
                for d in it.by_ref() {
                    if d.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// What a tool call is about, for the progress line: the command, path, pattern, query or URL from its arguments, else a
/// short JSON, cut to one short line. An approval card gets [`whole_detail`] instead.
pub(super) fn tool_detail(input: &Value) -> String {
    clip(&whole_detail(input), 160)
}

/// What a tool call is about, for its approval card: as [`tool_detail`], but whole, its line breaks kept. What a person
/// approves is what runs, so nothing of it is cut (item 117); the card and the phone scroll a long one.
pub(super) fn whole_detail(input: &Value) -> String {
    if let Some(d) = known_detail(input) {
        return d;
    }
    match input {
        Value::Object(m) if m.is_empty() => String::new(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// The command, path, pattern, query or URL a tool call's arguments name, when they name one, whole.
fn known_detail(input: &Value) -> Option<String> {
    for k in ["command", "cmd", "file_path", "path", "notebook_path", "pattern", "query", "url", "code", "description", "prompt"] {
        if let Some(v) = input.get(k) {
            if let Some(t) = v.as_str() {
                if !t.trim().is_empty() {
                    return Some(t.to_string());
                }
            }
            if let Some(a) = v.as_array() {
                let parts: Vec<String> = a.iter().filter_map(|x| x.as_str().map(String::from)).collect();
                if !parts.is_empty() {
                    return Some(parts.join(" "));
                }
            }
        }
    }
    // oh-my-pi's hashline edit: `[path#TAG]` on the first line of `input`
    if let Some(t) = input.get("input").and_then(Value::as_str) {
        let first = t.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
        let first = first.trim_start_matches('[').split('#').next().unwrap_or(first).trim_end_matches(']');
        if !first.is_empty() {
            return Some(first.to_string());
        }
    }
    None
}

/// How much of a plan (`ExitPlanMode`) the approval card gets; a longer one is cut there.
pub(super) const PLAN_CHARS: usize = 20_000;

/// What an approval card shows for a tool that is neither a command nor a file edit: the skill's name (and its
/// arguments) for `Skill`, the command / path / query when the input has one ([`known_detail`]'s keys), else each
/// top-level field as `name: value`, joined with ` · ` (a nested value as compact JSON), never the whole input as
/// one JSON string. Whole, never cut: the card scrolls a long one (item 117).
pub(super) fn ask_detail(name: &str, input: &Value) -> String {
    if name == "Skill" {
        let line = [s(input, "skill"), s(input, "args")].into_iter().filter(|x| !x.trim().is_empty()).collect::<Vec<_>>().join(" ");
        if !line.is_empty() {
            return line;
        }
    }
    if let Some(d) = known_detail(input) {
        return d;
    }
    let Value::Object(m) = input else { return whole_detail(input) };
    let parts: Vec<String> = m
        .iter()
        .filter_map(|(k, v)| {
            let t = match v {
                Value::Null => return None,
                Value::String(t) if t.trim().is_empty() => return None,
                Value::String(t) => t.clone(),
                Value::Array(a) if a.iter().all(Value::is_string) => a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "),
                other => other.to_string(),
            };
            Some(format!("{k}: {t}"))
        })
        .collect();
    parts.join(" · ")
}

/// Claude Code's own report of its MCP servers (`mcp_servers` in its `init` line: `name` and `status`, headless docs) as the
/// page may see it: each name as one short line, and the status as one of a few fixed words (`connected`, `failed`,
/// `needs_auth`, `pending`, `off`, else `other`), so nothing else the agent put there reaches the page.
pub(crate) fn mcp_seen(list: &[Value]) -> Vec<Value> {
    list.iter()
        .take(100)
        .filter_map(|x| {
            let name: String = s(x, "name").chars().filter(|c| !c.is_control()).take(80).collect();
            let status = match s(x, "status").as_str() {
                "connected" => "connected",
                "failed" => "failed",
                "needs-auth" | "needs_auth" => "needs_auth",
                "pending" => "pending",
                "disabled" => "off",
                _ => "other",
            };
            (!name.trim().is_empty()).then(|| json!({"name": name.trim(), "status": status}))
        })
        .collect()
}

/// An MCP tool's server and tool, from Claude Code's name for it (`mcp__<server>__<tool>`), or None for any other tool.
pub(crate) fn mcp_parts(name: &str) -> Option<(String, String)> {
    let (server, tool) = name.strip_prefix("mcp__")?.split_once("__")?;
    (!server.is_empty() && !tool.is_empty()).then(|| (server.to_string(), tool.to_string()))
}

/// The most of an MCP tool's input an ask carries. A longer input is cut there, and the ask is then not marked whole.
const MCP_INPUT_CHARS: usize = 4_000;

/// What an MCP tool is given, for its ask: each top-level field as `name: value` on a line of its own (a nested value as
/// compact JSON), by name, and whether that is all of it. What an MCP tool writes, sends or
/// posts is in its input, so the person reads it whole before allowing it.
pub(super) fn mcp_input(input: &Value) -> (String, bool) {
    let text = match input {
        Value::Object(m) => m
            .iter()
            .filter_map(|(k, v)| match v {
                Value::Null => None,
                Value::String(t) => Some(format!("{k}: {t}")),
                other => Some(format!("{k}: {other}")),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    if text.chars().count() <= MCP_INPUT_CHARS {
        (text, true)
    } else {
        (format!("{}…", text.chars().take(MCP_INPUT_CHARS).collect::<String>()), false)
    }
}

/// The bot chat's tool names for the verbs on the progress line ("Running", "Reading", "Editing" …).
pub(crate) fn tool_kind(name: &str) -> &str {
    match name.to_ascii_lowercase().as_str() {
        "bash" | "shell" | "exec" | "exec_command" | "local_shell" | "powershell" | "eval" => "terminal",
        "read" | "notebookread" | "view" => "read_file",
        "write" | "edit" | "multiedit" | "notebookedit" | "apply_patch" | "patch" | "ast_edit" => "patch",
        "grep" | "glob" | "ls" | "find" => "search_files",
        "websearch" | "web_search" => "web_search",
        "webfetch" | "fetch" => "web_extract",
        "task" | "agent" => "delegate_task",
        "skill" => "skill_view",
        _ => name,
    }
}

/// What the shell tells an agent when the person says no to a step. A result that is exactly this is a step that never
/// ran, not one that failed.
pub(super) const DENIED: &str = "The person denied this in Manut AI.";

/// Whether a Claude Code step's result says the step never ran: the shell's own refusal, or Claude Code's words when a
/// turn is stopped with the step waiting (claude-4-stopped.jsonl).
pub(super) fn never_ran(text: &str) -> bool {
    let t = text.trim();
    t == DENIED || t.starts_with("The user doesn't want to proceed with this tool use")
}

/// How much of the end of a command's output goes with its step's `tool.end` (`output`). The page reads a test run's
/// result from it (`src/code/testRun.ts`) and keeps none of it; a test run's summary is printed last, so the end is what
/// is kept, and a long output loses only its head.
pub(super) const OUTPUT_TAIL: usize = 8 * 1024;

/// The last `OUTPUT_TAIL` bytes of `text`, starting at a character.
pub(crate) fn output_tail(text: &str) -> &str {
    if text.len() <= OUTPUT_TAIL {
        return text;
    }
    let mut at = text.len() - OUTPUT_TAIL;
    while !text.is_char_boundary(at) {
        at += 1;
    }
    &text[at..]
}

/// A tool result's text: its `content` when that is a string, else the text of each of its blocks, one to a line.
pub(super) fn result_text(block: &Value) -> String {
    match block.get("content") {
        Some(Value::String(t)) => t.clone(),
        Some(Value::Array(list)) => list.iter().filter(|b| s(b, "type") == "text").map(|b| s(b, "text")).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// The longest command line that goes with a step's end.
pub(super) const COMMAND_MAX: usize = 4 * 1024;

/// The `tool.end` of a step that ran a command. `command` is its whole line (the step's start cut it to one short line),
/// for the page to tell a test run by; `output` is what it printed, when there was something and it is not the shell's own
/// refusal; `declined`: the person said no, so the command never ran.
pub(super) fn command_end(tool_id: &str, ok: bool, ms: u64, command: &str, output: &str, declined: bool) -> Value {
    let mut end = json!({"tool_id": tool_id, "name": "", "ok": ok, "ms": ms});
    if !command.trim().is_empty() {
        end["command"] = json!(command.chars().take(COMMAND_MAX).collect::<String>());
    }
    if declined {
        end["declined"] = json!(true);
    } else if !output.trim().is_empty() {
        end["output"] = json!(output_tail(output));
    }
    end
}

/// A file tool call as `path +a -d` (path relative to the session folder), from the arguments every agent
/// sends: Claude Code `Write {file_path, content}` / `Edit {file_path, old_string, new_string}` /
/// `MultiEdit {file_path, edits}`, pi `write {path, content}` / `edit {path, edits:[{oldText,newText}]}`.
fn file_call_detail(input: &Value, cwd: &str) -> String {
    let path = ["file_path", "path", "notebook_path"].iter().map(|k| s(input, k)).find(|p| !p.is_empty());
    let Some(path) = path else { return tool_detail(input) };
    let (mut a, mut d) = (0, 0);
    if let Some(c) = input.get("content").and_then(Value::as_str) {
        a += lines_of(c);
    }
    let mut pair = |old: &str, new: &str| {
        d += lines_of(old);
        a += lines_of(new);
    };
    if input.get("old_string").is_some() || input.get("new_string").is_some() {
        pair(&s(input, "old_string"), &s(input, "new_string"));
    }
    for e in input.get("edits").and_then(Value::as_array).into_iter().flatten() {
        let old = if e.get("old_string").is_some() { s(e, "old_string") } else { s(e, "oldText") };
        let new = if e.get("new_string").is_some() { s(e, "new_string") } else { s(e, "newText") };
        pair(&old, &new);
    }
    edit_detail(&[(rel(&path, cwd), a, d)])
}

/// The progress-line detail of a tool call: the diff summary for file tools, else the command / path / query.
pub(crate) fn call_detail(name: &str, input: &Value, cwd: &str) -> String {
    if tool_kind(name) == "patch" {
        file_call_detail(input, cwd)
    } else {
        tool_detail(input)
    }
}

pub(super) const CHOICES: [&str; 3] = ["deny", "once", "session"];

pub(super) fn with_cwd(mut f: Value, cwd: &str) -> Value {
    if !cwd.is_empty() {
        f["cwd"] = Value::String(cwd.to_string());
    }
    f
}

/// A clarify answer as text: a plain string, or a JSON array of labels (multi-select) joined with ", ".
pub(super) fn answer_text(v: &Value) -> String {
    match v {
        Value::String(t) => match serde_json::from_str::<Vec<String>>(t) {
            Ok(list) if t.trim_start().starts_with('[') => list.join(", "),
            _ => t.clone(),
        },
        Value::Array(a) => a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Questions for a clarify card: one question (`question` + `choices`), or several as an interview.
pub(super) fn clarify_event(request_id: &str, qs: &[(String, String, Vec<String>, bool)]) -> Event {
    // (qid, question, choices, multi)
    if qs.len() == 1 {
        let (_, q, choices, multi) = &qs[0];
        let mut f = json!({"request_id": request_id, "question": q});
        if !choices.is_empty() {
            f["choices"] = json!(choices);
        }
        if *multi {
            f["multi_select"] = Value::Bool(true);
        }
        return ev("clarify.request", f);
    }
    let questions: Vec<Value> = qs
        .iter()
        .map(|(qid, q, choices, multi)| {
            let mut x = json!({"qid": qid, "question": q});
            if !choices.is_empty() {
                x["choices"] = json!(choices);
            }
            if *multi {
                x["multi_select"] = Value::Bool(true);
            }
            x
        })
        .collect();
    ev("clarify.request", json!({"request_id": request_id, "question": qs.first().map(|q| q.1.clone()).unwrap_or_default(), "questions": questions}))
}

/// One answer per question id from a clarify input: a string answers the first (only) question; an object
/// maps question ids to answers (null = skipped).
pub(super) fn answers_by_qid(answer: &Value, qids: &[String]) -> Vec<(String, Option<String>)> {
    match answer {
        Value::Object(m) => qids.iter().map(|q| (q.clone(), m.get(q).filter(|v| !v.is_null()).map(answer_text))).collect(),
        other => qids.first().map(|q| vec![(q.clone(), Some(answer_text(other)))]).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clean_exit_mid_turn_ends_the_turn_without_an_error() {
        assert_eq!(exit_turn_end(Some(0), ""), json!({"event": "turn.end", "outcome": "ended"}));
        assert_eq!(exit_turn_end(Some(0), "boom"), json!({"event": "turn.end", "outcome": "error", "error": "boom"}));
        assert_eq!(exit_turn_end(Some(1), ""), json!({"event": "turn.end", "outcome": "error", "error": "the agent stopped"}));
        assert_eq!(exit_turn_end(None, ""), json!({"event": "turn.end", "outcome": "error", "error": "the agent stopped"}));
    }

    /// H11: a byte-order mark before a line, and two messages on one line, reach the adapter as protocol messages,
    /// one at a time, in order. A banner or a terminal frame is still nothing.
    #[test]
    fn protocol_lines_drop_a_bom_and_split_two_messages_on_one_line() {
        assert_eq!(protocol_lines("\u{feff}{\"a\":1}"), [r#"{"a":1}"#]);
        assert_eq!(protocol_lines(r#"{"type":"agent_end"}{"type":"agent_start"}"#), [r#"{"type":"agent_end"}"#, r#"{"type":"agent_start"}"#]);
        assert_eq!(protocol_lines(r#"{"a":1}  {"b":"}{"}"#), [r#"{"a":1}"#, r#"{"b":"}{"}"#]);
        assert!(protocol_lines("Welcome to OmO 3.0 (press q)").is_empty());
        assert!(protocol_lines("\u{1b}[?1049h\u{1b}[2J omo 3.0 interactive").is_empty());
        // a value cut short (a truncated line) yields what came before it
        assert_eq!(protocol_lines(r#"{"a":1}{"b":"#), [r#"{"a":1}"#]);
        assert!(protocol_lines("").is_empty());
    }

    // -- one shape across agents --

    #[test]
    fn every_agent_names_its_shell_tool_terminal_and_its_file_tools_patch() {
        for name in ["Bash", "bash", "shell", "exec_command", "local_shell", "eval"] {
            assert_eq!(tool_kind(name), "terminal", "{name}");
        }
        for name in ["Write", "Edit", "MultiEdit", "write", "edit", "apply_patch", "ast_edit"] {
            assert_eq!(tool_kind(name), "patch", "{name}");
        }
        assert_eq!(unwrap_shell("/bin/zsh -lc 'mkdir -p d1'"), "mkdir -p d1");
        assert_eq!(unwrap_shell("bash -c \"echo 'hi'\""), "echo 'hi'");
        assert_eq!(unwrap_shell("/bin/zsh -lc 'echo '\\''x'\\'''"), "echo 'x'");
        assert_eq!(unwrap_shell("ls -la"), "ls -la");
        assert_eq!(unwrap_shell("python -c 'x'"), "python -c 'x'");
    }

    #[test]
    fn exit_reasons_drop_colour_codes_and_config_warnings() {
        // Codex 0.167 (audit O8): a coloured log line that only warns about a config setting is no reason
        let codex = "\u{1b}[2m2026-11-11T10:25:23.520926Z\u{1b}[0m \u{1b}[31mERROR\u{1b}[0m \u{1b}[2mcodex_app_server\u{1b}[2m:\u{1b}[0m Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings.";
        assert_eq!(exit_reason(codex), "");
        let codex = format!("{codex}\n\u{1b}[2m2026-11-11T10:25:24Z\u{1b}[0m \u{1b}[31mERROR\u{1b}[0m codex_api: failed to connect");
        assert_eq!(exit_reason(&codex), "2026-11-11T10:25:24Z ERROR codex_api: failed to connect");
        // OmO's skills-catalog warning, then the real reason
        let omo = "Warning: The skills catalog uses one-line descriptions to limit request size (above 100 skills, 16 KiB of descriptions, or 48 KiB rendered). Remove unused skills to shrink every request.";
        assert_eq!(exit_reason(omo), "");
        assert_eq!(exit_reason(&format!("{omo}\nError: model not found")), "Error: model not found");
        assert_eq!(exit_turn_end(Some(0), &exit_reason(omo)), json!({"event": "turn.end", "outcome": "ended"}));
    }
}
