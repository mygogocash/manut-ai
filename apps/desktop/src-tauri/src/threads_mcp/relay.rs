//! The MCP server another program starts to reach the chats the person listed: this same program, run as
//! `manut --threads-mcp` (`main.rs` hands the flag here before anything of the app starts), speaking MCP over its standard
//! input and output (item 103, `docs/mcp-threads.md`).
//!
//! It holds nothing and decides nothing, as computer use's server does (`computer/mcp.rs`). It answers `initialize`,
//! `ping` and `tools/list` itself, refuses a call whose arguments are not the tool's own whole, and relays each other
//! `tools/call` as one line, `{tool, args, client}`, over the app's socket in `~/.manut/threads`, where every check is made
//! (`door.rs`) and the person answers on a card. Each call has a connection of its own, so a call the program gives up
//! (`notifications/cancelled`, or its input closing) closes only that connection, which tells the app to close its card.
//!
//! The messages are MCP's own (revision 2025-06-18): one JSON-RPC message a line; a tool's refusal is a result with
//! `isError`, so the program's model reads why; an unknown tool or method is a JSON-RPC error; a cancelled request is
//! never answered, as the specification asks.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::{MAX_AGENT, MAX_BRIEF, MAX_LIST, MAX_MESSAGE, MAX_TITLE, SERVER};
use crate::computer::mcp::VERSIONS;

/// The flag that starts this program as the threads server.
pub const FLAG: &str = "--threads-mcp";

/// What the program's model is told about this server: what it reaches and the rule that matters.
pub const INSTRUCTIONS: &str = "Reach the chats the person listed for other programs in Manut AI, on this Mac. Call list_chats first and name a chat by its number there; nothing else names a chat. Every read, message and new lane asks the person first on a card in Manut AI and happens once; a refusal is final for that call, so never repeat a call the person refused.";

/// The tools, by name.
pub const LIST: &str = "list_chats";
pub const READ: &str = "read_chat";
pub const SEND: &str = "send_to_chat";
pub const OPEN: &str = "open_chat";

/// The longest the relay waits for the app's answer: a minute longer than the app waits for the person (`door::WAIT`),
/// so the app's own word that the card closed is what the program hears.
const CALL_WAIT: Duration = Duration::from_secs(11 * 60);

/// What the program hears when the app cannot be reached.
const NO_APP: &str = "Manut AI could not be reached. Is the app open? Nothing was done.";

/// The tools and their arguments, as `tools/list` gives them. None answers, allows, denies, dismisses or stops anything,
/// and none changes a chat's mode, model, level or account: there is no verb for any of that (`docs/mcp-threads.md`).
pub fn tools() -> Value {
    let chat = json!({"type": "integer", "minimum": 1, "maximum": MAX_LIST, "description": "The chat's number in list_chats."});
    json!([
        {
            "name": LIST,
            "title": "List the chats",
            "description": "The chats the person listed for other programs in Manut AI: each one's number, title, agent and whether it is working, waiting on the person, or idle.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false},
        },
        {
            "name": READ,
            "title": "Read a chat",
            "description": "Read a listed chat. The person sees exactly the text that would be read on a card first, and it is read only if they allow it.",
            "inputSchema": {"type": "object", "properties": {"chat": chat}, "required": ["chat"], "additionalProperties": false},
        },
        {
            "name": SEND,
            "title": "Send a message to a chat",
            "description": "Send a message to a listed chat's agent. The person sees the words whole on a card first, and they go only if the person sends them. The message waits while that chat works or waits on the person; its words never answer that chat's questions or permission asks.",
            "inputSchema": {"type": "object", "properties": {
                "chat": chat,
                "message": {"type": "string", "minLength": 1, "maxLength": MAX_MESSAGE},
            }, "required": ["chat", "message"], "additionalProperties": false},
        },
        {
            "name": OPEN,
            "title": "Start a new lane",
            "description": "Start a new coding lane in the project of a listed chat, with a brief as its first message. The person sees the title, agent and brief whole on a card first, and the lane starts only if they start it, in its agent's Ask mode.",
            "inputSchema": {"type": "object", "properties": {
                "chat": chat,
                "title": {"type": "string", "minLength": 1, "maxLength": MAX_TITLE},
                "brief": {"type": "string", "minLength": 1, "maxLength": MAX_BRIEF},
                "agent": {"type": "string", "minLength": 1, "maxLength": MAX_AGENT},
            }, "required": ["chat", "title", "brief"], "additionalProperties": false},
        },
    ])
}

/// Why `args` are not `tool`'s own whole, or None when they are: every key is the tool's, every required one is there,
/// a chat is a whole number from 1 to `MAX_LIST`, and each text is not blank, within its length, and one line where one
/// line is taken. A call with anything else is refused whole, so nothing of a half-read call reaches a card.
pub fn wrong(tool: &str, args: &serde_json::Map<String, Value>) -> Option<String> {
    let (keys, required): (&[&str], &[&str]) = match tool {
        LIST => (&[], &[]),
        READ => (&["chat"], &["chat"]),
        SEND => (&["chat", "message"], &["chat", "message"]),
        OPEN => (&["chat", "title", "brief", "agent"], &["chat", "title", "brief"]),
        _ => return Some("Unknown tool.".into()),
    };
    if let Some(k) = args.keys().find(|k| !keys.contains(&k.as_str())) {
        return Some(format!("{tool} takes no \"{}\". Nothing was done.", short(k)));
    }
    if let Some(k) = required.iter().find(|k| !args.contains_key(**k)) {
        return Some(format!("{tool} needs \"{k}\". Nothing was done."));
    }
    if let Some(c) = args.get("chat") {
        if !c.as_u64().is_some_and(|n| (1..=MAX_LIST as u64).contains(&n)) {
            return Some(format!("\"chat\" is the chat's number in list_chats, from 1 to {MAX_LIST}. Nothing was done."));
        }
    }
    let text = |k: &str, max: usize, one_line: bool| -> Option<String> {
        let v = args.get(k)?;
        let Some(t) = v.as_str() else { return Some(format!("\"{k}\" is text. Nothing was done.")) };
        if t.trim().is_empty() {
            return Some(format!("\"{k}\" is empty. Nothing was done."));
        }
        if t.chars().count() > max {
            return Some(format!("\"{k}\" is longer than {max} characters. Nothing was done."));
        }
        if one_line && t.contains(['\n', '\r']) {
            return Some(format!("\"{k}\" is one line. Nothing was done."));
        }
        None
    };
    text("message", MAX_MESSAGE, false).or_else(|| text("title", MAX_TITLE, true)).or_else(|| text("brief", MAX_BRIEF, false)).or_else(|| text("agent", MAX_AGENT, true))
}

/// A key as a refusal names it: cut short, so a key holding a long text is not echoed back whole.
fn short(k: &str) -> String {
    let mut s: String = k.chars().take(40).collect();
    if k.chars().count() > 40 {
        s.push('…');
    }
    s
}

/// What one line from the program asks of the relay.
#[derive(Debug, PartialEq)]
pub enum Step {
    /// Answer the program with this line now.
    Reply(String),
    /// Relay a checked tool call to the app and answer request `id` with what comes back.
    Relay { id: Value, tool: String, args: Value },
    /// The program gave up request `id`.
    Cancel(Value),
    /// A notification that needs nothing.
    Nothing,
}

/// A JSON-RPC answer to request `id`.
fn result(id: &Value, r: Value) -> String {
    json!({"jsonrpc": "2.0", "id": id, "result": r}).to_string()
}

fn error(id: &Value, code: i64, message: &str) -> String {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}).to_string()
}

/// The answer to a tool call: the text, and whether it is a refusal.
pub fn tool_result(id: &Value, text: &str, is_error: bool) -> String {
    result(id, json!({"content": [{"type": "text", "text": text}], "isError": is_error}))
}

/// What to do with one line from the program. `client` keeps what the program called itself in `initialize`, which the
/// app shows only as the program's own words, never as its name.
pub fn step(line: &str, client: &mut Value) -> Step {
    let Ok(msg) = serde_json::from_str::<Value>(line) else {
        return Step::Reply(error(&Value::Null, -32700, "Parse error"));
    };
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let Some(id) = msg.get("id").cloned() else {
        return match method {
            "notifications/cancelled" => params.get("requestId").cloned().map(Step::Cancel).unwrap_or(Step::Nothing),
            _ => Step::Nothing,
        };
    };
    match method {
        "initialize" => {
            if let Some(info) = params.get("clientInfo").filter(|i| i.is_object()) {
                *client = json!({"name": info.get("name").cloned().unwrap_or(Value::Null), "version": info.get("version").cloned().unwrap_or(Value::Null)});
            }
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = VERSIONS.iter().find(|v| **v == asked).copied().unwrap_or(VERSIONS[0]);
            Step::Reply(result(
                &id,
                json!({
                    "protocolVersion": version,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": SERVER, "title": "Manut AI chats", "version": env!("CARGO_PKG_VERSION")},
                    "instructions": INSTRUCTIONS,
                }),
            ))
        }
        "ping" => Step::Reply(result(&id, json!({}))),
        "tools/list" => Step::Reply(result(&id, json!({"tools": tools()}))),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            if ![LIST, READ, SEND, OPEN].contains(&name) {
                return Step::Reply(error(&id, -32602, &format!("Unknown tool: {}", short(name))));
            }
            let args = match params.get("arguments") {
                None | Some(Value::Null) => serde_json::Map::new(),
                Some(Value::Object(a)) => a.clone(),
                Some(_) => return Step::Reply(error(&id, -32602, "Invalid arguments")),
            };
            if !cfg!(target_os = "macos") {
                return Step::Reply(tool_result(&id, "Other programs reach Manut AI's chats on the Mac only. Nothing was done.", true));
            }
            if let Some(why) = wrong(name, &args) {
                return Step::Reply(tool_result(&id, &why, true));
            }
            Step::Relay { id, tool: name.to_string(), args: Value::Object(args) }
        }
        _ => Step::Reply(error(&id, -32601, "Method not found")),
    }
}

/// The key a request id is kept under while its call is open: its JSON, since an id may be a number or a string.
fn key(id: &Value) -> String {
    id.to_string()
}

/// The app's answer to one call line, and whether the call's connection was registered in `open` (under `k`), where a
/// cancel can find and close it.
#[cfg(unix)]
fn ask_app(socket: &Path, k: &str, line: &str, open: &Arc<Mutex<HashMap<String, std::os::unix::net::UnixStream>>>) -> (Value, bool) {
    let fail = || json!({"text": NO_APP, "error": true});
    let Ok(mut s) = std::os::unix::net::UnixStream::connect(socket) else { return (fail(), false) };
    let _ = s.set_read_timeout(Some(CALL_WAIT));
    let _ = s.set_write_timeout(Some(Duration::from_secs(10)));
    let Ok(c) = s.try_clone() else { return (fail(), false) };
    open.lock().unwrap().insert(k.to_string(), c);
    if s.write_all(line.as_bytes()).and_then(|_| s.write_all(b"\n")).is_err() {
        return (fail(), true);
    }
    let mut back = String::new();
    if BufReader::new(s).read_line(&mut back).is_err() || back.is_empty() {
        return (fail(), true);
    }
    (serde_json::from_str(&back).unwrap_or_else(|_| fail()), true)
}

/// One relayed call: connect, send the line, keep the connection where a cancel can close it, wait for the line back.
/// Answers the program unless the call was cancelled meanwhile, which a missing entry in `open` says.
#[cfg(unix)]
fn relay_one(socket: &Path, id: Value, line: String, open: &Arc<Mutex<HashMap<String, std::os::unix::net::UnixStream>>>, out: &Arc<Mutex<dyn Write + Send>>) {
    let k = key(&id);
    let (answer, registered) = ask_app(socket, &k, &line, open);
    // a cancel took a registered call's entry out (and closed its connection): that request is never answered. A call
    // that never reached the app registered nothing, and the program hears that the app could not be reached.
    let cancelled = registered && open.lock().unwrap().remove(&k).is_none();
    if cancelled {
        return;
    }
    let text = answer.get("text").and_then(Value::as_str).unwrap_or("");
    let is_error = answer.get("error").and_then(Value::as_bool).unwrap_or(true);
    let mut o = out.lock().unwrap();
    let _ = writeln!(o, "{}", tool_result(&id, text, is_error)).and_then(|_| o.flush());
}

/// Serves MCP on `input` and `out` until the input closes, relaying calls to the app's socket at `socket`. When the input
/// closes, every call still open is closed, so the app closes their cards.
#[cfg(unix)]
pub fn serve(input: impl BufRead, out: Arc<Mutex<dyn Write + Send>>, socket: PathBuf) {
    let open: Arc<Mutex<HashMap<String, std::os::unix::net::UnixStream>>> = Arc::new(Mutex::new(HashMap::new()));
    let mut workers = Vec::new();
    let mut client = Value::Null;
    for line in input.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        match step(&line, &mut client) {
            Step::Reply(a) => {
                let mut o = out.lock().unwrap();
                if writeln!(o, "{a}").and_then(|_| o.flush()).is_err() {
                    break;
                }
            }
            Step::Relay { id, tool, args } => {
                let call = json!({"tool": tool, "args": args, "client": client}).to_string();
                let (open, out, socket) = (open.clone(), out.clone(), socket.clone());
                if let Ok(h) = std::thread::Builder::new().name("threads-call".into()).spawn(move || relay_one(&socket, id, call, &open, &out)) {
                    workers.push(h);
                }
            }
            Step::Cancel(id) => {
                if let Some(s) = open.lock().unwrap().remove(&key(&id)) {
                    let _ = s.shutdown(std::net::Shutdown::Both);
                }
            }
            Step::Nothing => {}
        }
    }
    for (_, s) in open.lock().unwrap().drain() {
        let _ = s.shutdown(std::net::Shutdown::Both);
    }
    for h in workers {
        let _ = h.join();
    }
}

/// `manut --threads-mcp`: serve MCP on standard input and output until the program closes them.
pub fn relay_main() -> i32 {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    #[cfg(unix)]
    {
        let out: Arc<Mutex<dyn Write + Send>> = Arc::new(Mutex::new(std::io::stdout()));
        serve(std::io::stdin().lock(), out, super::socket(&home));
    }
    #[cfg(not(unix))]
    {
        // no socket to reach: every call is answered by `step` itself, which refuses off the Mac
        let _ = home;
        let mut client = Value::Null;
        let mut out = std::io::stdout();
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if let Step::Reply(a) = step(&line, &mut client) {
                if writeln!(out, "{a}").and_then(|_| out.flush()).is_err() {
                    break;
                }
            }
        }
    }
    0
}

/// A calling program's side of the relay's input, for tests: its lines, then held open until `answered` says its answers
/// have come (ten seconds at most), then closed, as a real program keeps its end open while it waits. An input that ended
/// at once raced the call it had just made: the end of input closes every call still open, so whenever the call's thread
/// had opened its connection first, the call was closed unanswered (seen on a loaded macOS runner, 27 Nov 2026).
#[cfg(test)]
pub(crate) struct WaitsForAnswers<F: FnMut() -> bool> {
    lines: std::io::Cursor<Vec<u8>>,
    answered: F,
}

#[cfg(test)]
impl<F: FnMut() -> bool> WaitsForAnswers<F> {
    /// `lines` as the program wrote them, each ended with a newline so the last one is read before the wait.
    pub(crate) fn new(lines: &str, answered: F) -> std::io::BufReader<Self> {
        std::io::BufReader::new(WaitsForAnswers { lines: std::io::Cursor::new(format!("{}\n", lines.trim_end_matches('\n')).into_bytes()), answered })
    }
}

#[cfg(test)]
impl<F: FnMut() -> bool> std::io::Read for WaitsForAnswers<F> {
    fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
        let n = self.lines.read(b)?;
        if n > 0 {
            return Ok(n);
        }
        for _ in 0..2_000 {
            if (self.answered)() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        Ok(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(s: Step) -> Value {
        match s {
            Step::Reply(a) => serde_json::from_str(&a).unwrap(),
            other => panic!("a reply, not {other:?}"),
        }
    }

    fn call(tool: &str, args: Value) -> String {
        json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": tool, "arguments": args}}).to_string()
    }

    #[test]
    fn it_introduces_itself_and_keeps_what_the_program_calls_itself() {
        let mut client = Value::Null;
        let r = reply(step(&json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "clientInfo": {"name": "Cursor", "version": "2.1"}}}).to_string(), &mut client));
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(r["result"]["serverInfo"]["name"], SERVER);
        assert_eq!(r["result"]["capabilities"], json!({"tools": {}}));
        assert_eq!(client, json!({"name": "Cursor", "version": "2.1"}));
        let r = reply(step(&json!({"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {"protocolVersion": "1999-01-01"}}).to_string(), &mut client));
        assert_eq!(r["result"]["protocolVersion"], VERSIONS[0]);
        assert_eq!(reply(step(&json!({"jsonrpc": "2.0", "id": 3, "method": "ping"}).to_string(), &mut client))["result"], json!({}));
        assert_eq!(reply(step(&json!({"jsonrpc": "2.0", "id": 4, "method": "resources/list"}).to_string(), &mut client))["error"]["code"], -32601);
        assert_eq!(reply(step("{not json", &mut client))["error"]["code"], -32700);
    }

    /// The safety of the list itself: four tools, and no name, title or argument that answers, allows, denies, dismisses,
    /// stops, deletes or changes a mode, whatever a later edit adds to a description.
    #[test]
    fn no_tool_answers_an_ask_or_changes_a_chat() {
        let mut client = Value::Null;
        let r = reply(step(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).to_string(), &mut client));
        let tools = r["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, [LIST, READ, SEND, OPEN]);
        for t in tools {
            let words = format!("{} {} {}", t["name"], t["title"], t["inputSchema"]["properties"]).to_lowercase();
            for w in ["answer", "allow", "approve", "deny", "dismiss", "stop", "delete", "archive", "rename", "mode", "model", "permission", "account"] {
                assert!(!words.contains(w), "{w} in {words}");
            }
            assert_eq!(t["inputSchema"]["additionalProperties"], false);
        }
    }

    #[test]
    fn a_call_is_relayed_only_when_its_arguments_are_the_tools_own_whole() {
        let mut c = Value::Null;
        if !cfg!(target_os = "macos") {
            let r = reply(step(&call(READ, json!({"chat": 1})), &mut c));
            assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("Mac only"));
            return;
        }
        assert_eq!(step(&call(LIST, json!({})), &mut c), Step::Relay { id: json!(7), tool: LIST.into(), args: json!({}) });
        assert_eq!(step(&json!({"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": LIST}}).to_string(), &mut c), Step::Relay { id: json!(8), tool: LIST.into(), args: json!({}) });
        assert_eq!(step(&call(SEND, json!({"chat": 2, "message": "hello"})), &mut c), Step::Relay { id: json!(7), tool: SEND.into(), args: json!({"chat": 2, "message": "hello"}) });
        let refused = |tool: &str, args: Value| {
            let r = reply(step(&call(tool, args.clone()), &mut Value::Null));
            assert_eq!(r["result"]["isError"], true, "{tool} {args}");
            r["result"]["content"][0]["text"].as_str().unwrap().to_string()
        };
        // a key that is not the tool's refuses the whole call, a mode or an approval among them
        assert!(refused(SEND, json!({"chat": 1, "message": "hi", "approve": true})).contains("takes no \"approve\""));
        assert!(refused(OPEN, json!({"chat": 1, "title": "t", "brief": "b", "mode": "bypassPermissions"})).contains("takes no \"mode\""));
        assert!(refused(LIST, json!({"all": true})).contains("takes no"));
        assert!(refused(READ, json!({})).contains("needs \"chat\""));
        // a chat is its number on the list, never an id, a key or a title
        for bad in [json!(0), json!(11), json!(-1), json!(1.5), json!("1"), json!("agent:abc"), json!(null)] {
            assert!(refused(READ, json!({"chat": bad})).contains("number in list_chats"), "{bad}");
        }
        assert!(refused(SEND, json!({"chat": 1, "message": "   "})).contains("is empty"));
        assert!(refused(SEND, json!({"chat": 1, "message": "x".repeat(MAX_MESSAGE + 1)})).contains("longer than"));
        assert!(refused(OPEN, json!({"chat": 1, "title": "two\nlines", "brief": "b"})).contains("one line"));
        assert!(refused(OPEN, json!({"chat": 1, "title": "t", "brief": 3})).contains("is text"));
        // a refusal never echoes a long key whole
        assert!(!refused(READ, json!({"chat": 1, "k".repeat(500): 1})).contains(&"k".repeat(41)));
        assert_eq!(reply(step(&call("approve_ask", json!({})), &mut c))["error"]["code"], -32602);
        assert_eq!(reply(step(&json!({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": READ, "arguments": [1]}}).to_string(), &mut c))["error"]["code"], -32602);
    }

    #[test]
    fn a_cancel_names_its_request_and_other_notifications_need_nothing() {
        let mut c = Value::Null;
        assert_eq!(step(&json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 5, "reason": "timeout"}}).to_string(), &mut c), Step::Cancel(json!(5)));
        assert_eq!(step(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}).to_string(), &mut c), Step::Nothing);
        assert_eq!(step(&json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {}}).to_string(), &mut c), Step::Nothing);
    }

    /// A stand-in app on a real socket: it records each line it reads and answers it after `delay`, or never.
    #[cfg(target_os = "macos")]
    fn stand_in_app(dir: &Path, answer: Option<(&'static str, Duration)>) -> (PathBuf, Arc<Mutex<Vec<(Value, bool)>>>) {
        let _ = std::fs::remove_dir_all(dir);
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join("app.sock");
        let l = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let seen: Arc<Mutex<Vec<(Value, bool)>>> = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                let log = log.clone();
                std::thread::spawn(move || {
                    let mut line = String::new();
                    let mut r = BufReader::new(s.try_clone().unwrap());
                    r.read_line(&mut line).unwrap();
                    let i = {
                        let mut l = log.lock().unwrap();
                        l.push((serde_json::from_str(&line).unwrap(), false));
                        l.len() - 1
                    };
                    match answer {
                        Some((text, delay)) => {
                            std::thread::sleep(delay);
                            let mut s = s;
                            let _ = writeln!(s, "{}", json!({"text": text, "error": false}));
                        }
                        None => {
                            // wait for the relay to close the connection, and say it was closed
                            let mut rest = String::new();
                            let _ = r.read_line(&mut rest);
                            log.lock().unwrap()[i].1 = true;
                        }
                    }
                });
            }
        });
        (path, seen)
    }

    #[derive(Clone, Default)]
    struct Out(Arc<Mutex<Vec<u8>>>);

    impl Write for Out {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Out {
        fn lines(&self) -> Vec<Value> {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
        }
    }

    /// The whole road on a real socket: the handshake answered here, a call relayed with what the program called itself,
    /// and the app's answer returned as the tool's result.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_call_goes_to_the_app_with_the_programs_own_words_and_comes_back() {
        let d = std::env::temp_dir().join(format!("tm-relay-{}", std::process::id()));
        let (socket, seen) = stand_in_app(&d, Some(("1. Fix the login (Claude Code, idle)", Duration::from_millis(10))));
        let input = [
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"clientInfo": {"name": "Claude Code", "version": "2.9"}}}).to_string(),
            call(LIST, json!({})),
        ]
        .join("\n");
        let out = Out::default();
        let w: Arc<Mutex<dyn Write + Send>> = Arc::new(Mutex::new(out.clone()));
        // the program keeps its end open until both answers have come: closing it earlier would close the call
        let answers = out.clone();
        serve(WaitsForAnswers::new(&input, move || answers.0.lock().unwrap().iter().filter(|b| **b == b'\n').count() >= 2), w, socket);
        let lines = out.lines();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1]["id"], 7);
        assert_eq!(lines[1]["result"]["isError"], false);
        assert_eq!(lines[1]["result"]["content"][0]["text"], "1. Fix the login (Claude Code, idle)");
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].0, json!({"tool": LIST, "args": {}, "client": {"name": "Claude Code", "version": "2.9"}}));
        let _ = std::fs::remove_dir_all(d);
    }

    /// A call the program gives up closes its connection (so the app closes its card) and is never answered; so does
    /// every open call when the program closes the relay's input.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_cancelled_call_closes_its_connection_and_is_never_answered() {
        let d = std::env::temp_dir().join(format!("tm-cancel-{}", std::process::id()));
        let (socket, seen) = stand_in_app(&d, None);
        let (mut feed, input) = std::os::unix::net::UnixStream::pair().unwrap();
        let out = Out::default();
        let w: Arc<Mutex<dyn Write + Send>> = Arc::new(Mutex::new(out.clone()));
        let relay = std::thread::spawn(move || serve(BufReader::new(input), w, socket));
        writeln!(feed, "{}", call(READ, json!({"chat": 1}))).unwrap();
        writeln!(feed, "{}", json!({"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": READ, "arguments": {"chat": 2}}})).unwrap();
        let until = |n: usize, closed: usize| {
            for _ in 0..200 {
                let s = seen.lock().unwrap();
                if s.len() == n && s.iter().filter(|x| x.1).count() == closed {
                    return;
                }
                drop(s);
                std::thread::sleep(Duration::from_millis(10));
            }
            panic!("the stand-in app saw {:?}", seen.lock().unwrap());
        };
        until(2, 0);
        writeln!(feed, "{}", json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 7}})).unwrap();
        until(2, 1);
        // the program closes the relay's input: the call still open is closed too
        drop(feed);
        relay.join().unwrap();
        until(2, 2);
        assert!(out.lines().is_empty(), "no cancelled or abandoned call is answered: {:?}", out.lines());
        let _ = std::fs::remove_dir_all(d);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn no_app_is_said_plainly() {
        let d = std::env::temp_dir().join(format!("tm-noapp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let out = Out::default();
        let w: Arc<Mutex<dyn Write + Send>> = Arc::new(Mutex::new(out.clone()));
        serve(std::io::Cursor::new(call(LIST, json!({}))), w, d.join("app.sock"));
        let lines = out.lines();
        assert_eq!(lines[0]["result"]["isError"], true);
        assert_eq!(lines[0]["result"]["content"][0]["text"], NO_APP);
    }
}
