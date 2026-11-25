//! The MCP server a chat's Claude Code starts for computer use: this same program, run as `manut --computer-mcp`
//! (`main.rs` hands the flag here before anything of the app starts), speaking MCP over its standard input and output.
//!
//! It holds nothing and decides nothing. It answers `initialize`, `ping` and `tools/list` itself, and relays each
//! `tools/call` to the running app over the shell's socket with the chat's token (both given to it by the
//! configuration the shell wrote for that chat, `hub.rs`), where every check is made (`room.rs`). So a server started
//! any other way, or by a chat that has ended, can do nothing.
//!
//! The messages are MCP's own, as its specification (revision 2025-06-18) writes them: one JSON-RPC message a line,
//! `initialize` answered with the protocol version the client asked for when this server speaks it (else its newest),
//! the `tools` capability and `instructions`; `tools/list`; `tools/call` answered with `content` (text, and a picture as
//! `image` with `data` and `mimeType`) and `isError`; an unknown tool or method as a JSON-RPC error.

use std::io::{BufRead, BufReader, Write};
use std::time::Duration;

use serde_json::{json, Value};

use super::room;

/// The flag that starts this program as the MCP server.
pub const FLAG: &str = "--computer-mcp";
/// The environment the configuration gives the server: the chat's token and the shell's socket.
pub const TOKEN_VAR: &str = "MANUT_COMPUTER_TOKEN";
pub const SOCKET_VAR: &str = "MANUT_COMPUTER_SOCKET";

/// The protocol versions this server speaks, newest first.
pub const VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// What Claude Code shows the model about this server: when to use it and the one rule that matters.
pub const INSTRUCTIONS: &str = "Look at and work the windows of the apps on this Mac, when the person asks for something only an app's window can do. Prefer a command, a file or an API when one can do it. Load the computer-use skill before the first call. Every click, typing, key press and menu choice asks the person first on a card and runs once; never repeat an action the person refused.";

/// The longest a relayed call may take: a look at a large window, or an app slow to answer.
const CALL_WAIT: Duration = Duration::from_secs(90);

/// A JSON-RPC answer to request `id`.
fn result(id: &Value, r: Value) -> String {
    json!({"jsonrpc": "2.0", "id": id, "result": r}).to_string()
}

fn error(id: &Value, code: i64, message: &str) -> String {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}).to_string()
}

/// The answer to one line from the client, or None for a notification (which is never answered). `call` relays a tool
/// call and gives back the shell's reply: `{text, image?, error}`, `image` a PNG in base64.
pub fn answer(line: &str, call: &mut dyn FnMut(&str, &Value) -> Value) -> Option<String> {
    let Ok(msg) = serde_json::from_str::<Value>(line) else {
        return Some(error(&Value::Null, -32700, "Parse error"));
    };
    let id = msg.get("id")?.clone();
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    Some(match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = VERSIONS.iter().find(|v| **v == asked).copied().unwrap_or(VERSIONS[0]);
            result(
                &id,
                json!({
                    "protocolVersion": version,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": super::SERVER, "title": "Manut AI computer use", "version": env!("CARGO_PKG_VERSION")},
                    "instructions": INSTRUCTIONS,
                }),
            )
        }
        "ping" => result(&id, json!({})),
        "tools/list" => result(&id, json!({"tools": room::tools()})),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let known = room::tools().as_array().is_some_and(|t| t.iter().any(|x| x["name"] == name));
            if !known {
                return Some(error(&id, -32602, &format!("Unknown tool: {name}")));
            }
            let args = match params.get("arguments") {
                None | Some(Value::Null) => json!({}),
                Some(a) if a.is_object() => a.clone(),
                Some(_) => return Some(error(&id, -32602, "Invalid arguments")),
            };
            let reply = call(name, &args);
            let mut content = vec![json!({"type": "text", "text": reply.get("text").and_then(Value::as_str).unwrap_or("")})];
            if let Some(png) = reply.get("image").and_then(Value::as_str) {
                content.push(json!({"type": "image", "data": png, "mimeType": "image/png"}));
            }
            result(&id, json!({"content": content, "isError": reply.get("error").and_then(Value::as_bool).unwrap_or(true)}))
        }
        _ => error(&id, -32601, "Method not found"),
    })
}

/// One call relayed to the shell: a line out, a line back.
#[cfg(unix)]
pub fn over_socket(socket: &str, token: &str, tool: &str, args: &Value) -> Value {
    let fail = |why: &str| json!({"text": format!("Manut AI could not be reached ({why}). Is the app still open?"), "error": true});
    let Ok(mut s) = std::os::unix::net::UnixStream::connect(socket) else { return fail("no answer") };
    let _ = s.set_read_timeout(Some(CALL_WAIT));
    let _ = s.set_write_timeout(Some(Duration::from_secs(10)));
    let line = json!({"token": token, "tool": tool, "args": args}).to_string();
    if s.write_all(line.as_bytes()).and_then(|_| s.write_all(b"\n")).is_err() {
        return fail("it closed");
    }
    let mut back = String::new();
    if BufReader::new(s).read_line(&mut back).is_err() || back.is_empty() {
        return fail("no reply");
    }
    serde_json::from_str(&back).unwrap_or_else(|_| fail("a reply it could not read"))
}

/// `manut --computer-mcp`: serve MCP on standard input and output until the client closes them.
pub fn relay_main() -> i32 {
    let token = std::env::var(TOKEN_VAR).unwrap_or_default();
    let socket = std::env::var(SOCKET_VAR).unwrap_or_default();
    let mut call = |tool: &str, args: &Value| -> Value {
        #[cfg(unix)]
        {
            if token.is_empty() || socket.is_empty() {
                return json!({"text": "Computer use was not started by Manut AI for this chat.", "error": true});
            }
            over_socket(&socket, &token, tool, args)
        }
        #[cfg(not(unix))]
        {
            let _ = (tool, args, &token, &socket);
            json!({"text": "Computer use is on the Mac only.", "error": true})
        }
    };
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(a) = answer(&line, &mut call) {
            if writeln!(out, "{a}").and_then(|_| out.flush()).is_err() {
                break;
            }
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(line: Value, call: &mut dyn FnMut(&str, &Value) -> Value) -> Value {
        serde_json::from_str(&answer(&line.to_string(), call).unwrap()).unwrap()
    }

    fn none(_: &str, _: &Value) -> Value {
        panic!("nothing is relayed")
    }

    #[test]
    fn introduces_itself_in_the_version_the_client_speaks() {
        let r = ask(json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "claude-code", "version": "2"}}}), &mut none);
        assert_eq!(r["id"], 1);
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(r["result"]["capabilities"], json!({"tools": {}}));
        assert_eq!(r["result"]["serverInfo"]["name"], "manut-computer");
        assert!(r["result"]["instructions"].as_str().unwrap().contains("asks the person first"));
        // a version it does not speak: its newest
        let r = ask(json!({"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {"protocolVersion": "1999-01-01"}}), &mut none);
        assert_eq!(r["result"]["protocolVersion"], VERSIONS[0]);
        // a notification is never answered
        assert_eq!(answer(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}).to_string(), &mut none), None);
        assert_eq!(ask(json!({"jsonrpc": "2.0", "id": 3, "method": "ping"}), &mut none)["result"], json!({}));
        assert_eq!(ask(json!({"jsonrpc": "2.0", "id": 4, "method": "resources/list"}), &mut none)["error"]["code"], -32601);
        assert_eq!(serde_json::from_str::<Value>(&answer("{not json", &mut none).unwrap()).unwrap()["error"]["code"], -32700);
    }

    /// The six tools, the reads marked read-only and every write marked as needing a person; and no tool takes a list
    /// of actions, so one yes can never cover several.
    #[test]
    fn lists_six_tools_and_none_takes_a_batch() {
        let r = ask(json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}), &mut none);
        let tools = r["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["list_windows", "get_app_state", "click", "set_value", "press_key", "choose_menu_item"]);
        for t in tools {
            let name = t["name"].as_str().unwrap();
            let write = room::WRITES.contains(&name);
            assert_eq!(t["annotations"]["readOnlyHint"], json!(!write), "{name}");
            assert_eq!(t["_meta"]["anthropic/requiresUserInteraction"] == json!(true), write, "{name}");
            for (field, schema) in t["inputSchema"]["properties"].as_object().unwrap() {
                // the one list any tool takes is a menu item's path of titles: one item
                if schema["type"] == "array" {
                    assert_eq!((name, field.as_str(), &schema["items"]["type"]), ("choose_menu_item", "menu", &json!("string")));
                }
                assert!(schema["type"] != "object", "{name}.{field}");
            }
        }
    }

    #[test]
    fn relays_a_call_and_returns_its_text_and_picture() {
        let mut seen = Vec::new();
        let mut call = |tool: &str, args: &Value| {
            seen.push((tool.to_string(), args.clone()));
            json!({"text": "TextEdit, window 1 of 1", "image": "iVBORw0KGgo=", "error": false})
        };
        let r = ask(json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "get_app_state", "arguments": {"app": "TextEdit", "picture": true}}}), &mut call);
        assert_eq!(r["result"]["isError"], false);
        assert_eq!(r["result"]["content"][0], json!({"type": "text", "text": "TextEdit, window 1 of 1"}));
        assert_eq!(r["result"]["content"][1], json!({"type": "image", "data": "iVBORw0KGgo=", "mimeType": "image/png"}));
        assert_eq!(seen, [("get_app_state".to_string(), json!({"app": "TextEdit", "picture": true}))]);
        // a refusal is the tool's error, in words the agent reads
        let mut refuse = |_: &str, _: &Value| json!({"text": "no yes", "error": true});
        let r = ask(json!({"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": "click", "arguments": {"app": "TextEdit", "element_index": 2}}}), &mut refuse);
        assert_eq!(r["result"]["isError"], true);
        // a tool it does not have, or arguments that are not an object, never reach the shell
        assert_eq!(ask(json!({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "run_shell", "arguments": {}}}), &mut none)["error"]["code"], -32602);
        assert_eq!(ask(json!({"jsonrpc": "2.0", "id": 10, "method": "tools/call", "params": {"name": "click", "arguments": [1, 2]}}), &mut none)["error"]["code"], -32602);
    }

    /// With no socket to reach, a call says so as the tool's error rather than hanging.
    #[cfg(unix)]
    #[test]
    fn a_call_with_no_app_to_reach_says_so() {
        let r = over_socket("/nonexistent/manut-computer.sock", "t", "list_windows", &json!({}));
        assert_eq!(r["error"], true);
        assert!(r["text"].as_str().unwrap().contains("could not be reached"));
    }
}
