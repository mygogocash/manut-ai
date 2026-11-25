//! Where a computer use call meets the chat's card: an adapter around Claude Code's own (`agent_chat`'s `Claude`), for
//! a chat that was handed computer use (`hub::attach`).
//!
//! Claude Code asks permission for each MCP tool call (`can_use_tool`, Buddy's chat runs in its `default` mode, where
//! everything asks). For a computer use tool (`mcp__manut-computer__<tool>`) the room decides first (`room.rs`):
//!
//! - **Free** (the list of apps; a look at an app the person already allowed in this chat): answered here, at once,
//!   with Claude Code's own allow, and no card.
//! - **Refused** (Manut AI's own windows, System Settings, the keychain, a password field, a blocked shortcut, the
//!   locked screen...): answered here with Claude Code's own deny and the reason, and no card.
//! - **A card**: the Claude adapter makes its card as for any ask, and this adapter puts it in the app's own words
//!   (the title, and every line whole: app, window, control, text, keys or menu), offers only No and Allow once (never
//!   "for this session", which would let Claude Code skip the next ask), and adds `tool.computer` so the page draws it
//!   in the person's language. The person's Allow once becomes the room's yes for exactly that call, recorded before
//!   Claude Code hears the answer, so the call that follows finds it.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};

use super::room::{Ask, Decision, Room};
use crate::agent_chat::{Adapter, Input, Step};

/// The prefix of a computer use tool's name in Claude Code.
pub const PREFIX: &str = "mcp__manut-computer__";

/// The choices a computer use card offers: No and Allow once.
pub const CHOICES: [&str; 2] = ["deny", "once"];

pub struct Tap {
    inner: Box<dyn Adapter>,
    room: Arc<Room>,
    /// The cards open now, by Claude Code's request id: the tool, its input and what its yes would be for.
    pending: HashMap<String, (String, Value, Ask)>,
}

impl Tap {
    pub fn wrap(inner: Box<dyn Adapter>, room: Arc<Room>) -> Box<dyn Adapter> {
        Box::new(Tap { inner, room, pending: HashMap::new() })
    }
}

/// A Claude Code permission request for a computer use tool: its request id, the tool and its input.
fn computer_ask(v: &Value) -> Option<(String, String, Value)> {
    if v.get("type")?.as_str()? != "control_request" {
        return None;
    }
    let req = v.get("request")?;
    if req.get("subtype")?.as_str()? != "can_use_tool" {
        return None;
    }
    let tool = req.get("tool_name")?.as_str()?.strip_prefix(PREFIX)?.to_string();
    let rid = v.get("request_id")?.as_str()?.to_string();
    let input = req.get("input").cloned().filter(Value::is_object).unwrap_or_else(|| json!({}));
    Some((rid, tool, input))
}

/// Claude Code's own answer to permission request `rid`, as the Claude adapter writes it.
fn answer(rid: &str, response: Value) -> String {
    json!({"type": "control_response", "response": {"subtype": "success", "request_id": rid, "response": response}}).to_string()
}

impl Adapter for Tap {
    fn start(&mut self) -> Step {
        self.inner.start()
    }

    fn on_line(&mut self, line: &str) -> Step {
        let v = serde_json::from_str::<Value>(line).unwrap_or(Value::Null);
        if v.get("type").and_then(Value::as_str) == Some("control_cancel_request") {
            if let Some(rid) = v.get("request_id").and_then(Value::as_str) {
                self.pending.remove(rid);
            }
        }
        let Some((rid, tool, args)) = computer_ask(&v) else { return self.inner.on_line(line) };
        match self.room.ask(&tool, &args) {
            Decision::Free => Step { write: vec![answer(&rid, json!({"behavior": "allow", "updatedInput": args}))], events: Vec::new() },
            Decision::Refuse(why) => Step { write: vec![answer(&rid, json!({"behavior": "deny", "message": why}))], events: Vec::new() },
            Decision::Card(ask) => {
                let mut st = self.inner.on_line(line);
                for e in st.events.iter_mut().filter(|e| e["event"] == "approval.request" && e["request_id"] == rid.as_str()) {
                    e["title"] = Value::String(ask.shown.title());
                    e["command"] = Value::String(ask.shown.lines());
                    e["whole"] = Value::Bool(true);
                    e["choices"] = json!(CHOICES);
                    if !e["tool"].is_object() {
                        e["tool"] = json!({"kind": "other"});
                    }
                    e["tool"]["computer"] = serde_json::to_value(&ask.shown).unwrap_or(Value::Null);
                }
                self.pending.insert(rid, (tool, args, ask));
                st
            }
        }
    }

    fn on_input(&mut self, input: Input) -> Result<Step, String> {
        let Input::Approve { request_id, choice } = &input else { return self.inner.on_input(input) };
        let Some((tool, args, ask)) = self.pending.get(request_id).cloned() else { return self.inner.on_input(input) };
        if !CHOICES.contains(&choice.as_str()) {
            return Err("A computer use ask is answered No or Allow once".into());
        }
        let once = choice == "once";
        let rid = request_id.clone();
        // the yes is recorded before Claude Code hears it, so the call it then makes finds it; a request the agent has
        // already taken back (the Claude adapter refuses the answer) records nothing
        if once {
            self.room.answered(&tool, &args, &ask);
        }
        match self.inner.on_input(input) {
            Ok(step) => {
                self.pending.remove(&rid);
                Ok(step)
            }
            Err(e) => {
                if once {
                    self.room.forget(&tool, &args);
                }
                Err(e)
            }
        }
    }

    fn in_turn(&self) -> bool {
        self.inner.in_turn()
    }

    fn explain(&self, err: &str) -> String {
        self.inner.explain(err)
    }

    fn name(&self) -> &str {
        self.inner.name()
    }

    fn unrecognized(&self) -> bool {
        self.inner.unrecognized()
    }

    fn models(&self) -> Vec<String> {
        self.inner.models()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_chat::adapter_for;
    use crate::computer::room::NO_YES;
    use crate::computer::stand::{Stand, TEXTEDIT};

    fn tap() -> (Arc<Stand>, Arc<Room>, Box<dyn Adapter>) {
        let s = Arc::new(Stand::new());
        let room = Arc::new(Room::new(s.clone()));
        (s, room.clone(), Tap::wrap(adapter_for("claude", "/Users/me/.manut/buddy/chat", None).unwrap(), room))
    }

    /// Claude Code's permission request for a tool, as it sends one (`--permission-prompt-tool stdio`).
    fn request(rid: &str, tool: &str, input: Value) -> String {
        json!({"type": "control_request", "request_id": rid, "request": {"subtype": "can_use_tool", "tool_name": tool, "display_name": tool, "input": input, "tool_use_id": "t1"}}).to_string()
    }

    fn written(st: &Step) -> Value {
        assert_eq!(st.write.len(), 1, "{:?}", st.write);
        serde_json::from_str(&st.write[0]).unwrap()
    }

    #[test]
    fn listing_and_looking_at_an_allowed_app_need_no_card() {
        let (_, room, mut a) = tap();
        let st = a.on_line(&request("r1", "mcp__manut-computer__list_windows", json!({})));
        assert!(st.events.is_empty());
        let w = written(&st);
        assert_eq!(w["response"]["request_id"], "r1");
        assert_eq!(w["response"]["response"], json!({"behavior": "allow", "updatedInput": {}}));
        // the person allowed TextEdit on an earlier card: a look is answered at once
        let args = json!({"app": "TextEdit"});
        let Decision::Card(ask) = room.ask("get_app_state", &args) else { panic!() };
        room.answered("get_app_state", &args, &ask);
        let st = a.on_line(&request("r2", "mcp__manut-computer__get_app_state", json!({"app": "TextEdit", "window": 2})));
        assert!(st.events.is_empty());
        assert_eq!(written(&st)["response"]["response"]["behavior"], "allow");
    }

    /// A card in the app's own words, with No and Allow once only, and the person's Allow once the room's yes.
    #[test]
    fn an_action_is_a_card_in_the_apps_words_and_allow_once_is_its_one_yes() {
        let (s, room, mut a) = tap();
        let look = json!({"app": "TextEdit"});
        let st = a.on_line(&request("r1", "mcp__manut-computer__get_app_state", look.clone()));
        assert!(st.write.is_empty(), "nothing is answered before the person");
        let card = st.events.iter().find(|e| e["event"] == "approval.request").unwrap();
        assert_eq!(card["title"], "Let the agent look at TextEdit in this chat?");
        assert_eq!(card["choices"], json!(["deny", "once"]));
        assert_eq!(card["whole"], true);
        assert_eq!(card["tool"]["computer"], json!({"act": "look", "app": "TextEdit"}));
        assert_eq!(card["tool"]["server"], "manut-computer");
        let st = a.on_input(Input::Approve { request_id: "r1".into(), choice: "once".into() }).unwrap();
        assert_eq!(written(&st)["response"]["response"], json!({"behavior": "allow", "updatedInput": look}));
        assert!(!room.run("get_app_state", &look).error);

        let click = json!({"app": "TextEdit", "element_index": 2});
        let st = a.on_line(&request("r2", "mcp__manut-computer__click", click.clone()));
        let card = st.events.iter().find(|e| e["event"] == "approval.request").unwrap();
        assert_eq!(card["title"], "Click button “Save” in TextEdit?");
        assert_eq!(card["command"], "App: TextEdit\nWindow: Untitled\nControl: button “Save”");
        assert_eq!(card["tool"]["computer"]["control"], "button “Save”");
        // never "for this session", which would let Claude Code act again unasked
        assert!(a.on_input(Input::Approve { request_id: "r2".into(), choice: "session".into() }).is_err());
        assert_eq!(room.run("click", &click).text, NO_YES);
        a.on_input(Input::Approve { request_id: "r2".into(), choice: "once".into() }).unwrap();
        assert!(!room.run("click", &click).error);
        assert_eq!(room.run("click", &click).text, NO_YES, "one yes, one click");
        assert_eq!(s.acts(), [format!("press {TEXTEDIT} 0 1")]);
        // the same card cannot be answered twice
        assert!(a.on_input(Input::Approve { request_id: "r2".into(), choice: "once".into() }).is_err());
        assert_eq!(room.run("click", &click).text, NO_YES);
    }

    #[test]
    fn a_no_or_a_withdrawn_ask_leaves_no_yes() {
        let (s, room, mut a) = tap();
        let look = json!({"app": "TextEdit"});
        a.on_line(&request("r1", "mcp__manut-computer__get_app_state", look.clone()));
        a.on_input(Input::Approve { request_id: "r1".into(), choice: "once".into() }).unwrap();
        room.run("get_app_state", &look);
        let click = json!({"app": "TextEdit", "element_index": 2});
        a.on_line(&request("r2", "mcp__manut-computer__click", click.clone()));
        let st = a.on_input(Input::Approve { request_id: "r2".into(), choice: "deny".into() }).unwrap();
        assert_eq!(written(&st)["response"]["response"]["behavior"], "deny");
        assert_eq!(room.run("click", &click).text, NO_YES);
        // Claude Code takes an ask back (Stop): its card goes and an answer that comes late gives no yes
        a.on_line(&request("r3", "mcp__manut-computer__click", click.clone()));
        a.on_line(&json!({"type": "control_cancel_request", "request_id": "r3"}).to_string());
        assert!(a.on_input(Input::Approve { request_id: "r3".into(), choice: "once".into() }).is_err());
        assert_eq!(room.run("click", &click).text, NO_YES);
        assert!(s.acts().is_empty());
    }

    #[test]
    fn a_refused_target_is_denied_with_its_reason_and_never_shown_as_a_card() {
        let (s, _, mut a) = tap();
        for (rid, tool, input) in [
            ("r1", "get_app_state", json!({"app": "System Settings"})),
            ("r2", "click", json!({"app": "Manut AI", "element_index": 2})),
            ("r3", "press_key", json!({"app": "TextEdit", "key": "Cmd+Q"})),
            ("r4", "choose_menu_item", json!({"app": "TextEdit", "menu": ["Apple", "Lock Screen"]})),
        ] {
            let st = a.on_line(&request(rid, &format!("{PREFIX}{tool}"), input));
            assert!(st.events.iter().all(|e| e["event"] != "approval.request"), "{tool}");
            let w = written(&st);
            assert_eq!(w["response"]["response"]["behavior"], "deny", "{tool}");
            assert!(!w["response"]["response"]["message"].as_str().unwrap().is_empty());
        }
        s.lock(true);
        let st = a.on_line(&request("r5", "mcp__manut-computer__list_windows", json!({})));
        assert_eq!(written(&st)["response"]["response"]["behavior"], "deny");
        assert!(s.acts().is_empty());
    }

    /// Every other ask is the Claude adapter's, unchanged.
    #[test]
    fn other_asks_pass_through_unchanged() {
        let (_, _, mut a) = tap();
        let mut plain = adapter_for("claude", "/Users/me/.manut/buddy/chat", None).unwrap();
        for line in [request("r1", "Bash", json!({"command": "ls"})), request("r2", "mcp__shop__orders", json!({"status": "open"})), request("r3", "mcp__manut-computerx__click", json!({}))] {
            assert_eq!(a.on_line(&line), plain.on_line(&line));
        }
        let ok = a.on_input(Input::Approve { request_id: "r1".into(), choice: "session".into() });
        assert_eq!(ok.unwrap(), plain.on_input(Input::Approve { request_id: "r1".into(), choice: "session".into() }).unwrap());
    }
}
