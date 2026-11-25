//! What one chat may look at and do on this Mac, and every check on the way, with the Mac itself behind [`Desk`] so the
//! tests drive it with a stand-in and nothing here touches the real screen.
//!
//! A chat's agent reaches six tools (their names are Orca's commands, as MCP tools): `list_windows` and
//! `get_app_state` look; `click`, `set_value`, `press_key` and `choose_menu_item` act. Each call passes here twice:
//!
//! 1. **When the agent asks** ([`Room::ask`], from Claude Code's permission request, `tap.rs`). Listing the apps is
//!    free. Looking at an app the person already let this chat look at is free; looking at any other app is a card
//!    ("Let the agent look at TextEdit in this chat?"). Every action is a card that names the app, the window, the
//!    control and the text or key exactly. A target computer use never touches is refused here, before any card.
//! 2. **When it runs** ([`Room::run`], from the MCP server through the shell's socket, `hub.rs`). A look runs only for
//!    an app the person allowed in this chat. An action runs only with a yes the person gave on its card for exactly
//!    that call ([`Room::answered`]), used once and gone, within [`GRANT_TTL`]; it is checked again against the Mac as
//!    it is now (the same control, still not a password field, the app still allowed, the screen not locked) and acts
//!    on the very control the card named. So a rule in the person's own Claude Code settings that would let a tool run
//!    unasked does not let it act: with no yes here, it is refused.
//!
//! Never, for a look or an action: Manut AI's own windows (an agent must not read or answer its own asks), System
//! Settings, the places macOS keeps passwords (Keychain Access, Passwords) and the prompts where macOS asks for a
//! password, a fingerprint or a permission ([`REFUSED`]); what a password field holds; anything while the screen is
//! locked or another person's session is in front.

use std::any::Any;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use super::keys::{self, Chord};

/// A control on the Mac, as the desk holds it (an accessibility element there, a number in a test).
pub type Handle = Arc<dyn Any + Send + Sync>;

/// A running app with at least one window.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct App {
    pub pid: i32,
    pub name: String,
    /// Its bundle identifier, or empty when it has none.
    pub bundle: String,
}

/// One element of a window's accessibility tree, in the order the tree is walked.
#[derive(Clone)]
pub struct Node {
    pub depth: usize,
    /// The accessibility role and subrole (`AXButton`, `AXSecureTextField`).
    pub role: String,
    pub subrole: String,
    /// What the control is called: its title, else its description, else its placeholder.
    pub label: String,
    /// What it holds. Never read for a password field, by the desk, and dropped here again if one ever came.
    pub value: Option<String>,
    pub enabled: bool,
    pub handle: Handle,
}

impl Node {
    /// A password field: macOS marks it with the secure text field role or subrole.
    pub fn secure(&self) -> bool {
        self.role == SECURE || self.subrole == SECURE
    }
}

/// Apple's `kAXSecureTextFieldSubrole`.
pub const SECURE: &str = "AXSecureTextField";

/// What the Mac answers, behind one interface so the tests use a stand-in (`mac.rs` is the real one).
pub trait Desk: Send + Sync {
    /// Whether macOS lets this app use accessibility, read without asking (`AXIsProcessTrusted`).
    fn accessibility(&self) -> bool;
    /// Whether macOS lets this app capture the screen, read without asking (`CGPreflightScreenCaptureAccess`).
    fn screen(&self) -> bool;
    /// The screen is locked or asleep, or this person's session is not the one in front, or that cannot be told.
    fn locked(&self) -> bool;
    /// This app's own process.
    fn own_pid(&self) -> i32;
    /// The running apps that have a window.
    fn apps(&self) -> Vec<App>;
    /// The titles of an app's windows, frontmost first.
    fn windows(&self, pid: i32) -> Result<Vec<String>, String>;
    /// Window `window` (0-based) of app `pid`, walked to at most [`MAX_NODES`] elements and [`MAX_DEPTH`] levels.
    fn tree(&self, pid: i32, window: usize) -> Result<Vec<Node>, String>;
    /// A PNG picture of that window.
    fn picture(&self, pid: i32, window: usize) -> Result<Vec<u8>, String>;
    /// The control read again now, or None when it is gone.
    fn again(&self, handle: &Handle) -> Option<Node>;
    /// The title of the app's focused window, where its keys go.
    fn focused_window(&self, pid: i32) -> Option<String>;
    fn press(&self, handle: &Handle) -> Result<(), String>;
    fn set_value(&self, handle: &Handle, text: &str) -> Result<(), String>;
    fn key(&self, pid: i32, chord: &Chord) -> Result<(), String>;
    fn menu(&self, pid: i32, path: &[String]) -> Result<(), String>;
}

/// The most elements a look reads, and the deepest level.
pub const MAX_NODES: usize = 400;
pub const MAX_DEPTH: usize = 30;
/// How long a yes waits for its action: Claude Code calls the tool as soon as it has the answer.
pub const GRANT_TTL: Duration = Duration::from_secs(120);
/// The longest text `set_value` types, a label or a value shown, and a menu item's name.
pub const TEXT_CHARS: usize = 2_000;
const SHOWN_CHARS: usize = 200;
const MENU_ITEM_CHARS: usize = 100;
const MENU_DEPTH: usize = 6;

pub const LIST: &str = "list_windows";
pub const LOOK: &str = "get_app_state";
pub const CLICK: &str = "click";
pub const SET: &str = "set_value";
pub const KEY: &str = "press_key";
pub const MENU: &str = "choose_menu_item";
/// The tools that change something: each one a card, a yes and one run.
pub const WRITES: [&str; 4] = [CLICK, SET, KEY, MENU];

/// Manut AI's own bundle identifier (`tauri.conf.json`).
pub const OWN_BUNDLE: &str = "xyz.manut.desktop";

/// The apps computer use never looks at or works, each with the words a refusal uses. Bundle identifiers read from
/// this Mac's own `Info.plist` files (macOS 27.2): System Settings, the two places passwords are kept, the login and
/// lock screen and the screen saver, and every prompt where macOS asks for a password, Touch ID, a permission or an
/// "open anyway".
pub const REFUSED: [(&str, &str); 12] = [
    ("com.apple.systempreferences", "System Settings"),
    ("com.apple.keychainaccess", "Keychain Access, where macOS keeps passwords"),
    ("com.apple.Passwords", "Passwords, where macOS keeps passwords"),
    ("com.apple.security.Keychain-Circle-Notification", "a keychain prompt"),
    ("com.apple.loginwindow", "the login and lock screen"),
    ("com.apple.ScreenSaver.Engine", "the screen saver"),
    ("com.apple.SecurityAgent", "a password prompt"),
    ("com.apple.LocalAuthentication.UIAgent", "a Touch ID or password prompt"),
    ("com.apple.tcc.AuthorizationPromptService", "a permission prompt"),
    ("com.apple.accessibility.universalAccessAuthWarn", "the Accessibility permission prompt"),
    ("com.apple.UserNotificationCenter", "a system alert"),
    ("com.apple.coreservices.uiagent", "a prompt about opening an app or file"),
];

/// Why computer use stays away from `app`, or None when it may look at it.
pub fn refused(app: &App, own_pid: i32) -> Option<String> {
    if app.pid == own_pid || app.bundle.eq_ignore_ascii_case(OWN_BUNDLE) {
        return Some("Manut AI's own windows, where you are asked before anything acts".into());
    }
    REFUSED.iter().find(|(b, _)| app.bundle.eq_ignore_ascii_case(b)).map(|(_, why)| (*why).to_string())
}

/// What a card shows, as the page draws it in the person's language (`tool.computer` on the ask).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Shown {
    /// `look`, `click`, `set`, `key` or `menu`.
    pub act: &'static str,
    pub app: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keys: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menu: Option<Vec<String>>,
}

impl Shown {
    /// The card's title, in English: the page puts it in the person's language from the fields above.
    pub fn title(&self) -> String {
        match self.act {
            "look" => format!("Let the agent look at {} in this chat?", self.app),
            "click" => format!("Click {} in {}?", self.control.as_deref().unwrap_or("a control"), self.app),
            "set" => format!("Type into {} in {}?", self.control.as_deref().unwrap_or("a field"), self.app),
            "key" => format!("Press {} in {}?", self.keys.as_deref().unwrap_or(""), self.app),
            _ => format!("Choose {} in {}?", self.menu.as_deref().unwrap_or_default().join(" › "), self.app),
        }
    }

    /// The card's lines, in English, each whole: what is touched and exactly what is typed.
    pub fn lines(&self) -> String {
        let mut l = vec![format!("App: {}", self.app)];
        if let Some(w) = &self.window {
            l.push(format!("Window: {w}"));
        }
        if let Some(c) = &self.control {
            l.push(format!("Control: {c}"));
        }
        if let Some(k) = &self.keys {
            l.push(format!("Keys: {k}"));
        }
        if let Some(m) = &self.menu {
            l.push(format!("Menu: {}", m.join(" › ")));
        }
        if let Some(t) = &self.text {
            l.push(format!("Text: {t}"));
        }
        if self.act == "look" {
            l.push(format!("It may read the text and controls of {}'s windows and take their picture until this chat ends. Never what a password field holds.", self.app));
        }
        l.join("\n")
    }
}

/// What a yes is for: the very control, key or menu item the card named.
#[derive(Clone)]
enum Target {
    App { key: String },
    /// A click, or with `value` the text put into a field.
    Node { pid: i32, role: String, label: String, handle: Handle, value: Option<String> },
    Key { pid: i32, window: Option<String>, chord: Chord },
    Menu { pid: i32, path: Vec<String> },
}

/// One ask's card and what its yes would be for.
#[derive(Clone)]
pub struct Ask {
    pub shown: Shown,
    target: Target,
}

/// What happens to an agent's call when it asks.
pub enum Decision {
    /// Nothing to ask: listing the apps, or looking at an app already allowed in this chat.
    Free,
    /// A card for the person.
    Card(Ask),
    /// Never: computer use does not do it, and says why.
    Refuse(String),
}

/// What a tool answers the agent.
#[derive(Debug, Default, PartialEq)]
pub struct Reply {
    pub text: String,
    /// A PNG picture of a window.
    pub image: Option<Vec<u8>>,
    pub error: bool,
}

impl Reply {
    fn ok(text: impl Into<String>) -> Reply {
        Reply { text: text.into(), image: None, error: false }
    }
    pub fn err(text: impl Into<String>) -> Reply {
        Reply { text: text.into(), image: None, error: true }
    }
}

/// The latest look at one app in this chat: what `element_index` counts in.
struct Look {
    title: String,
    nodes: Vec<Node>,
}

struct Grant {
    tool: String,
    args: Value,
    target: Target,
    at: Instant,
}

#[derive(Default)]
struct State {
    /// The apps (by bundle identifier, else name) the person let this chat look at.
    allowed: Vec<String>,
    looks: HashMap<i32, Look>,
    grants: Vec<Grant>,
}

/// One chat's computer use: what it may look at, its latest looks and the yeses waiting for their action.
pub struct Room {
    desk: Arc<dyn Desk>,
    state: Mutex<State>,
}

pub const NO_YES: &str = "Manut AI has no yes from the person for this action. Each action runs only right after the person allows it once on its card in the chat, and that yes is used once. If they said no, do not try again unless they ask.";
const LOCKED: &str = "The Mac's screen is locked or asleep, or someone else's session is in front, so computer use does nothing now. Ask the person to unlock the Mac and say when.";
const NO_ACCESSIBILITY: &str = "macOS has not given Manut AI Accessibility, so computer use cannot read or work any window. The person turns it on in Manut AI's Settings › Computer.";

/// The key an app is allowed under: its bundle identifier, else its name.
fn app_key(app: &App) -> String {
    if app.bundle.is_empty() { app.name.to_lowercase() } else { app.bundle.to_lowercase() }
}

/// `t` cut to `n` characters on one line, for a card or a tree.
fn short(t: &str, n: usize) -> String {
    let one = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= n { one } else { format!("{}…", one.chars().take(n - 1).collect::<String>()) }
}

/// A role as words: `AXTextArea` is "text area".
pub fn role_words(role: &str) -> String {
    let r = role.strip_prefix("AX").unwrap_or(role);
    let mut out = String::new();
    for (i, c) in r.chars().enumerate() {
        if c.is_uppercase() && i > 0 {
            out.push(' ');
        }
        out.extend(c.to_lowercase());
    }
    if out.is_empty() { "element".into() } else { out }
}

/// A control as the card and the tree name it: `button “Save”`, `text field “Name”`, `password field`.
pub fn control_name(n: &Node) -> String {
    let what = if n.secure() { "password field".to_string() } else { role_words(&n.role) };
    if n.label.trim().is_empty() { what } else { format!("{what} “{}”", short(&n.label, SHOWN_CHARS)) }
}

/// `args[k]` as text that is not blank.
fn text_arg<'a>(args: &'a Value, k: &str) -> Option<&'a str> {
    args.get(k).and_then(Value::as_str).filter(|t| !t.trim().is_empty())
}

/// `args[k]` as a whole number of at least 1.
fn index_arg(args: &Value, k: &str) -> Option<usize> {
    args.get(k).and_then(Value::as_u64).filter(|n| *n >= 1 && *n <= 100_000).map(|n| n as usize)
}

/// Text the agent may type: not too long, and no control character but a line break or a tab.
fn typed_ok(t: &str) -> Result<(), String> {
    if t.chars().count() > TEXT_CHARS {
        return Err(format!("The text is longer than {TEXT_CHARS} characters."));
    }
    if t.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
        return Err("The text holds a control character that cannot be typed.".into());
    }
    Ok(())
}

/// The apple menu's own title, as accessibility names it (the Apple logo, U+F8FF), and its name in words.
fn apple_menu(item: &str) -> bool {
    let t = item.trim();
    t == "\u{F8FF}" || t.eq_ignore_ascii_case("apple")
}

impl Room {
    pub fn new(desk: Arc<dyn Desk>) -> Room {
        Room { desk, state: Mutex::new(State::default()) }
    }

    /// The running app the agent names, by bundle identifier or name, in any case.
    fn find(&self, args: &Value) -> Result<App, String> {
        let q = text_arg(args, "app").ok_or("Name the app (`app`): its name or bundle identifier, as `list_windows` gives them.")?.trim();
        let apps = self.desk.apps();
        if let Some(a) = apps.iter().find(|a| !a.bundle.is_empty() && a.bundle.eq_ignore_ascii_case(q)) {
            return Ok(a.clone());
        }
        let named: Vec<&App> = apps.iter().filter(|a| a.name.eq_ignore_ascii_case(q)).collect();
        match named.as_slice() {
            [one] => Ok((*one).clone()),
            [] => Err(format!("No running app with a window is called \"{q}\". Call `list_windows` to see them.")),
            _ => Err(format!("More than one app is called \"{q}\": name it by its bundle identifier.")),
        }
    }

    /// The app, unless computer use never touches it.
    fn target_app(&self, args: &Value) -> Result<App, String> {
        let app = self.find(args)?;
        if let Some(why) = refused(&app, self.desk.own_pid()) {
            return Err(format!("Computer use never looks at or works {why}."));
        }
        Ok(app)
    }

    /// The agent asks for `tool` with `args`: free, a card, or refused.
    pub fn ask(&self, tool: &str, args: &Value) -> Decision {
        match self.ask_inner(tool, args) {
            Ok(d) => d,
            Err(why) => Decision::Refuse(why),
        }
    }

    fn ask_inner(&self, tool: &str, args: &Value) -> Result<Decision, String> {
        if !self.desk.accessibility() {
            return Err(NO_ACCESSIBILITY.into());
        }
        if self.desk.locked() {
            return Err(LOCKED.into());
        }
        if tool == LIST {
            return Ok(Decision::Free);
        }
        let app = self.target_app(args)?;
        let shown = |act| Shown { act, app: app.name.clone(), window: None, control: None, text: None, keys: None, menu: None };
        match tool {
            LOOK => {
                let key = app_key(&app);
                if self.state.lock().unwrap().allowed.contains(&key) {
                    return Ok(Decision::Free);
                }
                Ok(Decision::Card(Ask { shown: shown("look"), target: Target::App { key } }))
            }
            CLICK | SET => {
                let i = index_arg(args, "element_index").ok_or("Name the control by its `element_index` from the latest `get_app_state`.")?;
                let st = self.state.lock().unwrap();
                let look = st.looks.get(&app.pid).ok_or_else(|| format!("Call `get_app_state` for {} first, then name a control from it.", app.name))?;
                let n = look.nodes.get(i - 1).ok_or_else(|| format!("There is no element [{i}] in the latest look at {}.", app.name))?;
                if n.secure() {
                    return Err("Computer use never touches a password field.".into());
                }
                let mut s = Shown { window: Some(look.title.clone()), control: Some(control_name(n)), ..shown(if tool == CLICK { "click" } else { "set" }) };
                if tool == SET {
                    let t = args.get("value").and_then(Value::as_str).ok_or("Give the text to put in the field (`value`).")?;
                    typed_ok(t)?;
                    s.text = Some(t.to_string());
                }
                let target = Target::Node { pid: app.pid, role: n.role.clone(), label: n.label.clone(), handle: n.handle.clone(), value: s.text.clone() };
                Ok(Decision::Card(Ask { shown: s, target }))
            }
            KEY => {
                let chord = keys::parse(text_arg(args, "key").ok_or("Name the key (`key`), for example \"Return\" or \"Cmd+S\".")?)?;
                if let Some(effect) = chord.blocked() {
                    return Err(format!("{} would {effect}, so computer use never sends it. Reach the goal another way, such as the window's own button or menu item.", chord.shown()));
                }
                let window = self.desk.focused_window(app.pid);
                let s = Shown { window: window.clone(), keys: Some(chord.shown()), ..shown("key") };
                Ok(Decision::Card(Ask { shown: s, target: Target::Key { pid: app.pid, window, chord } }))
            }
            MENU => {
                let path: Vec<String> = args
                    .get("menu")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).map(|s| s.trim().to_string()).collect())
                    .unwrap_or_default();
                let n = args.get("menu").and_then(Value::as_array).map_or(0, Vec::len);
                if path.len() < 2 || path.len() != n || path.len() > MENU_DEPTH || path.iter().any(|p| p.is_empty() || p.chars().count() > MENU_ITEM_CHARS || p.chars().any(char::is_control)) {
                    return Err(format!("Name the menu item as its path of titles (`menu`), from the menu bar down, for example [\"File\", \"Save…\"]: two to {MENU_DEPTH} titles."));
                }
                if apple_menu(&path[0]) {
                    return Err("Computer use never chooses from the Apple menu, which reaches System Settings, logging out and shutting down.".into());
                }
                let s = Shown { menu: Some(path.clone()), ..shown("menu") };
                Ok(Decision::Card(Ask { shown: s, target: Target::Menu { pid: app.pid, path } }))
            }
            other => Err(format!("{other} is not a computer use tool.")),
        }
    }

    /// The person allowed `ask` once, on its card: a look lets this chat look at that app until it ends; an action gets
    /// one yes, for exactly this call.
    pub fn answered(&self, tool: &str, args: &Value, ask: &Ask) {
        let mut st = self.state.lock().unwrap();
        match &ask.target {
            Target::App { key } => {
                if !st.allowed.contains(key) {
                    st.allowed.push(key.clone());
                }
            }
            target => st.grants.push(Grant { tool: tool.to_string(), args: args.clone(), target: target.clone(), at: Instant::now() }),
        }
    }

    /// Takes back the newest yes for exactly this call: the answer that gave it never reached the agent.
    pub fn forget(&self, tool: &str, args: &Value) {
        let mut st = self.state.lock().unwrap();
        if let Some(at) = st.grants.iter().rposition(|g| g.tool == tool && &g.args == args) {
            st.grants.remove(at);
        }
    }

    /// The yes for exactly this call, taken so it is never used again; None when there is none.
    fn take(&self, tool: &str, args: &Value) -> Option<Target> {
        let mut st = self.state.lock().unwrap();
        st.grants.retain(|g| g.at.elapsed() < GRANT_TTL);
        let at = st.grants.iter().position(|g| g.tool == tool && &g.args == args)?;
        Some(st.grants.remove(at).target)
    }

    /// The tool runs: everything is checked again against the Mac as it is now.
    pub fn run(&self, tool: &str, args: &Value) -> Reply {
        if !self.desk.accessibility() {
            return Reply::err(NO_ACCESSIBILITY);
        }
        if self.desk.locked() {
            // a yes waiting for this call is spent too: it was for the Mac as it was before the lock
            let _ = self.take(tool, args);
            return Reply::err(LOCKED);
        }
        match tool {
            LIST => self.list(),
            LOOK => self.look(args).unwrap_or_else(Reply::err),
            t if WRITES.contains(&t) => {
                let Some(target) = self.take(tool, args) else { return Reply::err(NO_YES) };
                self.act(target).unwrap_or_else(Reply::err)
            }
            other => Reply::err(format!("{other} is not a computer use tool.")),
        }
    }

    fn list(&self) -> Reply {
        let own = self.desk.own_pid();
        let allowed = self.state.lock().unwrap().allowed.clone();
        let mut out = vec!["Apps with windows on this Mac. You may look at an app with `get_app_state`; the first look at each app in this chat asks the person.".to_string()];
        for app in self.desk.apps().iter().filter(|a| refused(a, own).is_none()) {
            let id = if app.bundle.is_empty() { String::new() } else { format!(" ({})", app.bundle) };
            if allowed.contains(&app_key(app)) {
                let titles = self.desk.windows(app.pid).unwrap_or_default();
                out.push(format!("- {}{id}, allowed in this chat, {} window(s):", app.name, titles.len()));
                for (i, t) in titles.iter().enumerate() {
                    out.push(format!("  {}. {}", i + 1, if t.trim().is_empty() { "(untitled)".to_string() } else { short(t, SHOWN_CHARS) }));
                }
            } else {
                // a window's title can say private things: only an app the person allowed shows them
                out.push(format!("- {}{id}", app.name));
            }
        }
        Reply::ok(out.join("\n"))
    }

    fn look(&self, args: &Value) -> Result<Reply, String> {
        let app = self.target_app(args)?;
        if !self.state.lock().unwrap().allowed.contains(&app_key(&app)) {
            return Err(format!("The person has not let this chat look at {}. Looking asks them first, on a card in the chat.", app.name));
        }
        let titles = self.desk.windows(app.pid)?;
        if titles.is_empty() {
            return Err(format!("{} has no window open.", app.name));
        }
        let w = match args.get("window") {
            None | Some(Value::Null) => 1,
            Some(_) => index_arg(args, "window").ok_or("`window` is a window's number from `list_windows`, from 1.")?,
        };
        if w > titles.len() {
            return Err(format!("{} has {} window(s); there is no window {w}.", app.name, titles.len()));
        }
        let mut nodes = self.desk.tree(app.pid, w - 1)?;
        nodes.truncate(MAX_NODES);
        for n in nodes.iter_mut().filter(|n| n.secure()) {
            n.value = None;
        }
        let title = titles[w - 1].clone();
        let text = render(&app, w, titles.len(), &title, &nodes);
        let mut reply = Reply::ok(text);
        if args.get("picture").and_then(Value::as_bool) == Some(true) {
            if !self.desk.screen() {
                reply.text.push_str("\n\nNo picture: macOS has not given Manut AI Screen capture. The person can turn it on in Settings › Computer.");
            } else {
                match self.desk.picture(app.pid, w - 1) {
                    Ok(png) => reply.image = Some(png),
                    Err(e) => reply.text.push_str(&format!("\n\nNo picture: {e}")),
                }
            }
        }
        self.state.lock().unwrap().looks.insert(app.pid, Look { title, nodes });
        Ok(reply)
    }

    /// The app `pid` names, when it still runs and computer use may still touch it.
    fn still_app(&self, pid: i32) -> Result<App, String> {
        let app = self.desk.apps().into_iter().find(|a| a.pid == pid).ok_or("The app is no longer open, so nothing was done.")?;
        if let Some(why) = refused(&app, self.desk.own_pid()) {
            return Err(format!("Computer use never looks at or works {why}."));
        }
        Ok(app)
    }

    fn act(&self, target: Target) -> Result<Reply, String> {
        match target {
            Target::App { .. } => Err(NO_YES.into()),
            Target::Node { pid, role, label, handle, value } => {
                let app = self.still_app(pid)?;
                let now = self.desk.again(&handle).ok_or("The control is gone from the window, so nothing was done. Look again.")?;
                if now.secure() {
                    return Err("Computer use never touches a password field.".into());
                }
                if now.role != role || now.label != label {
                    return Err("The control changed since the person said yes, so nothing was done. Look again and ask again.".into());
                }
                let name = control_name(&now);
                match value {
                    None => {
                        self.desk.press(&handle)?;
                        Ok(Reply::ok(format!("Clicked {name} in {}. Call `get_app_state` to see what changed.", app.name)))
                    }
                    Some(text) => {
                        self.desk.set_value(&handle, &text)?;
                        // read back: an app can take the text, change it or ignore it
                        let held = self.desk.again(&handle).and_then(|n| n.value);
                        let how = if held.as_deref() == Some(text.as_str()) { "it now holds exactly that text" } else { "it does not read back as exactly that text, so check with `get_app_state` before going on" };
                        Ok(Reply::ok(format!("Typed into {name} in {}: {how}.", app.name)))
                    }
                }
            }
            Target::Key { pid, window, chord } => {
                let app = self.still_app(pid)?;
                if chord.blocked().is_some() {
                    return Err("Computer use never sends that shortcut.".into());
                }
                if window.is_some() && self.desk.focused_window(pid) != window {
                    return Err(format!("A different window of {} is in front now, so the key was not pressed. Look again and ask again.", app.name));
                }
                self.desk.key(pid, &chord)?;
                Ok(Reply::ok(format!("Pressed {} in {}. Call `get_app_state` to see what changed.", chord.shown(), app.name)))
            }
            Target::Menu { pid, path } => {
                let app = self.still_app(pid)?;
                self.desk.menu(pid, &path)?;
                Ok(Reply::ok(format!("Chose {} in {}. Call `get_app_state` to see what changed.", path.join(" › "), app.name)))
            }
        }
    }
}

/// The tree as the agent reads it: one element a line, `[n]` the number an action names, indented by depth.
pub fn render(app: &App, window: usize, windows: usize, title: &str, nodes: &[Node]) -> String {
    let id = if app.bundle.is_empty() { String::new() } else { format!(" ({})", app.bundle) };
    let mut out = vec![format!("{}{id}, window {window} of {windows}: “{}”", app.name, short(title, SHOWN_CHARS))];
    for (i, n) in nodes.iter().enumerate() {
        let mut line = format!("{}[{}] {}", "  ".repeat(n.depth.min(MAX_DEPTH)), i + 1, control_name(n));
        if n.secure() {
            line.push_str(" (what it holds is never read)");
        } else if let Some(v) = n.value.as_deref().filter(|v| !v.trim().is_empty()) {
            line.push_str(&format!(": {}", short(v, SHOWN_CHARS)));
        }
        if !n.enabled {
            line.push_str(" (disabled)");
        }
        out.push(line);
    }
    if nodes.len() >= MAX_NODES {
        out.push(format!("… the window has more than {MAX_NODES} elements; only these were read."));
    }
    out.join("\n")
}

/// The tool definitions the MCP server lists: the reads marked read-only, the writes marked as needing a person.
pub fn tools() -> Value {
    let app = json!({"type": "string", "description": "The app's name or bundle identifier, as list_windows gives them."});
    let element = json!({"type": "integer", "minimum": 1, "description": "The element's number, [n], from the latest get_app_state of this app."});
    let write_meta = json!({"anthropic/requiresUserInteraction": true});
    json!([
        {"name": LIST, "title": "List apps and windows", "description": "Lists the apps with windows on this Mac. Window titles show only for apps the person let this chat look at.",
         "inputSchema": {"type": "object", "properties": {}}, "annotations": {"readOnlyHint": true}},
        {"name": LOOK, "title": "Look at an app's window", "description": "Reads one window of an app as an accessibility tree of numbered elements, and with picture true also a picture of it. The first look at each app in a chat asks the person.",
         "inputSchema": {"type": "object", "properties": {"app": app, "window": {"type": "integer", "minimum": 1, "description": "The window's number from list_windows; the frontmost when left out."}, "picture": {"type": "boolean", "description": "Also return a picture of the window."}}, "required": ["app"]},
         "annotations": {"readOnlyHint": true}},
        {"name": CLICK, "title": "Click a control", "description": "Presses one element from the latest get_app_state. Asks the person first, every time.",
         "inputSchema": {"type": "object", "properties": {"app": app, "element_index": element}, "required": ["app", "element_index"]},
         "annotations": {"readOnlyHint": false, "destructiveHint": true}, "_meta": write_meta},
        {"name": SET, "title": "Type into a field", "description": "Puts text into one text field from the latest get_app_state, replacing what it holds. Asks the person first, every time. Never a password field.",
         "inputSchema": {"type": "object", "properties": {"app": app, "element_index": element, "value": {"type": "string", "maxLength": TEXT_CHARS}}, "required": ["app", "element_index", "value"]},
         "annotations": {"readOnlyHint": false, "destructiveHint": true}, "_meta": write_meta},
        {"name": KEY, "title": "Press a key", "description": "Presses one key, with modifiers if any (\"Return\", \"Escape\", \"Cmd+S\"), in the app's focused window. Asks the person first, every time. Shortcuts that quit, log out, lock the screen, force quit or empty the Trash are never sent.",
         "inputSchema": {"type": "object", "properties": {"app": app, "key": {"type": "string"}}, "required": ["app", "key"]},
         "annotations": {"readOnlyHint": false, "destructiveHint": true}, "_meta": write_meta},
        {"name": MENU, "title": "Choose a menu item", "description": "Chooses one item from the app's menu bar by its path of titles, such as [\"File\", \"Save…\"]. Asks the person first, every time. Never the Apple menu.",
         "inputSchema": {"type": "object", "properties": {"app": app, "menu": {"type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": MENU_DEPTH}}, "required": ["app", "menu"]},
         "annotations": {"readOnlyHint": false, "destructiveHint": true}, "_meta": write_meta},
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer::stand::{Stand, KEYCHAIN, NOTES, OWN, SETTINGS, TEXTEDIT};

    fn room() -> (Arc<Stand>, Room) {
        let s = Arc::new(Stand::new());
        (s.clone(), Room::new(s))
    }

    fn card(r: &Room, tool: &str, args: &Value) -> Ask {
        match r.ask(tool, args) {
            Decision::Card(a) => a,
            Decision::Free => panic!("{tool} was free"),
            Decision::Refuse(w) => panic!("{tool} was refused: {w}"),
        }
    }

    fn refused(r: &Room, tool: &str, args: &Value) -> String {
        match r.ask(tool, args) {
            Decision::Refuse(w) => w,
            _ => panic!("{tool} {args} was not refused"),
        }
    }

    /// The person lets the chat look at `app`, and the chat looks.
    fn look(r: &Room, app: &str) -> Reply {
        let args = json!({"app": app});
        if let Decision::Card(a) = r.ask(LOOK, &args) {
            r.answered(LOOK, &args, &a);
        }
        r.run(LOOK, &args)
    }

    #[test]
    fn listing_is_free_and_shows_window_titles_only_for_apps_allowed_in_this_chat() {
        let (s, r) = room();
        assert!(matches!(r.ask(LIST, &json!({})), Decision::Free));
        let list = r.run(LIST, &json!({})).text;
        assert!(list.contains("- TextEdit (com.apple.TextEdit)") && list.contains("- Notes"));
        // a window's title can say private things: none before the person allows the app
        assert!(!list.contains("Letter to the bank"));
        assert!(s.calls().is_empty(), "no app's windows were read");
        look(&r, "TextEdit");
        let list = r.run(LIST, &json!({})).text;
        assert!(list.contains("TextEdit (com.apple.TextEdit), allowed in this chat, 2 window(s):\n  1. Untitled\n  2. Letter to the bank.rtf"));
        assert!(!list.contains("Groceries"));
    }

    /// The first look at an app asks; after the person's yes the chat may look at that app (and no other) until it ends.
    #[test]
    fn a_look_at_an_app_asks_once_per_chat_and_reads_only_what_was_allowed() {
        let (s, r) = room();
        let args = json!({"app": "textedit"});
        let a = card(&r, LOOK, &args);
        assert_eq!(a.shown, Shown { act: "look", app: "TextEdit".into(), window: None, control: None, text: None, keys: None, menu: None });
        assert_eq!(a.shown.title(), "Let the agent look at TextEdit in this chat?");
        // run before the person answered: refused, and the window was not read
        let before = r.run(LOOK, &args);
        assert!(before.error && before.text.contains("has not let this chat look at TextEdit"));
        assert!(s.calls().is_empty());
        r.answered(LOOK, &args, &a);
        let seen = r.run(LOOK, &json!({"app": "TextEdit"}));
        assert!(!seen.error, "{}", seen.text);
        assert!(seen.text.starts_with("TextEdit (com.apple.TextEdit), window 1 of 2: “Untitled”\n[1] window “Untitled”\n  [2] button “Save”\n  [3] text area: Dear bank,"));
        assert!(seen.text.contains("[5] button “Cancel” (disabled)"));
        // now free, for this app only, and the second window by its number
        assert!(matches!(r.ask(LOOK, &json!({"app": "com.apple.TextEdit", "window": 2})), Decision::Free));
        assert!(r.run(LOOK, &json!({"app": "TextEdit", "window": 2})).text.contains("window 2 of 2: “Letter to the bank.rtf”"));
        assert!(r.run(LOOK, &json!({"app": "TextEdit", "window": 3})).error);
        assert!(matches!(r.ask(LOOK, &json!({"app": "Notes"})), Decision::Card(_)));
        assert!(r.run(LOOK, &json!({"app": "Notes"})).error);
        assert!(!s.calls().iter().any(|c| c.starts_with(&format!("tree {NOTES}"))));
        // another chat's room starts with nothing allowed
        let other = Room::new(s.clone());
        assert!(matches!(other.ask(LOOK, &args), Decision::Card(_)));
    }

    /// What a password field holds is never shown, even if the Mac handed it over, and it is never typed into or clicked.
    #[test]
    fn a_password_field_is_never_read_typed_into_or_clicked() {
        let (s, r) = room();
        let seen = look(&r, "TextEdit").text;
        assert!(seen.contains("[4] password field “Password” (what it holds is never read)"));
        assert!(!seen.contains("hunter2"));
        assert!(refused(&r, CLICK, &json!({"app": "TextEdit", "element_index": 4})).contains("password field"));
        assert!(refused(&r, SET, &json!({"app": "TextEdit", "element_index": 4, "value": "x"})).contains("password field"));
        // a field that becomes a password field after the yes is not typed into
        let args = json!({"app": "TextEdit", "element_index": 6, "value": "Mint"});
        let a = card(&r, SET, &args);
        r.answered(SET, &args, &a);
        s.change(TEXTEDIT, 0, 5, |x| x.subrole = SECURE);
        assert!(r.run(SET, &args).text.contains("password field"));
        assert!(s.acts().is_empty());
    }

    /// Manut AI's own windows (where its asks are answered), System Settings and Keychain Access are never looked at,
    /// listed or worked, whatever was allowed.
    #[test]
    fn manut_ai_system_settings_and_the_keychain_are_refused_before_any_card() {
        let (s, r) = room();
        for app in ["Manut AI", "xyz.manut.desktop", "System Settings", "com.apple.systempreferences", "Keychain Access"] {
            let why = refused(&r, LOOK, &json!({"app": app}));
            assert!(why.starts_with("Computer use never looks at or works"), "{app}: {why}");
            assert!(r.run(LOOK, &json!({"app": app})).error, "{app}");
            for (tool, args) in [(CLICK, json!({"app": app, "element_index": 2})), (KEY, json!({"app": app, "key": "Return"})), (MENU, json!({"app": app, "menu": ["File", "Save…"]}))] {
                assert!(matches!(r.ask(tool, &args), Decision::Refuse(_)), "{tool} {app}");
            }
        }
        assert!(refused(&r, LOOK, &json!({"app": "Manut AI"})).contains("Manut AI's own windows"));
        let list = r.run(LIST, &json!({})).text;
        for hidden in ["Manut AI", "System Settings", "Keychain Access"] {
            assert!(!list.contains(hidden), "{hidden}");
        }
        assert!(!s.calls().iter().any(|c| [OWN, SETTINGS, KEYCHAIN].iter().any(|p| c.contains(&format!(" {p}")))));
        for (bundle, _) in REFUSED {
            let app = App { pid: 9, name: "x".into(), bundle: bundle.to_uppercase() };
            assert!(super::refused(&app, 1).is_some(), "{bundle}");
        }
        assert!(super::refused(&App { pid: 9, name: "Notes".into(), bundle: "com.apple.Notes".into() }, 1).is_none());
    }

    /// One yes, one action: a write runs only after the person's Allow once on its own card, exactly as asked, once.
    #[test]
    fn each_action_runs_once_after_its_own_yes_and_never_without_one() {
        let (s, r) = room();
        look(&r, "TextEdit");
        let click = json!({"app": "TextEdit", "element_index": 2});
        let a = card(&r, CLICK, &click);
        assert_eq!(a.shown.title(), "Click button “Save” in TextEdit?");
        assert_eq!(a.shown.lines(), "App: TextEdit\nWindow: Untitled\nControl: button “Save”");
        // asked but not answered: nothing runs
        assert_eq!(r.run(CLICK, &click).text, NO_YES);
        r.answered(CLICK, &click, &a);
        // a yes is for exactly the call it was given for: not another control, not another tool
        assert_eq!(r.run(CLICK, &json!({"app": "TextEdit", "element_index": 6})).text, NO_YES);
        assert_eq!(r.run(SET, &json!({"app": "TextEdit", "element_index": 2, "value": "x"})).text, NO_YES);
        let done = r.run(CLICK, &click);
        assert!(!done.error && done.text.starts_with("Clicked button “Save” in TextEdit."), "{}", done.text);
        assert_eq!(s.acts(), [format!("press {TEXTEDIT} 0 1")]);
        // used once: the same call again is refused
        assert_eq!(r.run(CLICK, &click).text, NO_YES);
        // two yeses for the same click are two clicks, and no more
        for _ in 0..2 {
            let a = card(&r, CLICK, &click);
            r.answered(CLICK, &click, &a);
        }
        assert!(!r.run(CLICK, &click).error);
        assert!(!r.run(CLICK, &click).error);
        assert!(r.run(CLICK, &click).error);
        assert_eq!(s.acts().len(), 3);
        // a yes left unused goes after its time
        let a = card(&r, CLICK, &click);
        r.answered(CLICK, &click, &a);
        r.state.lock().unwrap().grants[0].at -= GRANT_TTL;
        assert_eq!(r.run(CLICK, &click).text, NO_YES);
        assert_eq!(s.acts().len(), 3);
    }

    #[test]
    fn typing_shows_the_exact_text_and_reads_it_back() {
        let (s, r) = room();
        look(&r, "TextEdit");
        let args = json!({"app": "TextEdit", "element_index": 6, "value": "Mint Shop\nBangkok"});
        let a = card(&r, SET, &args);
        assert_eq!(a.shown.title(), "Type into text field “Name” in TextEdit?");
        assert_eq!(a.shown.lines(), "App: TextEdit\nWindow: Untitled\nControl: text field “Name”\nText: Mint Shop\nBangkok");
        r.answered(SET, &args, &a);
        let done = r.run(SET, &args);
        assert!(done.text.contains("it now holds exactly that text"), "{}", done.text);
        assert_eq!(s.acts(), [format!("set {TEXTEDIT} 0 5 Mint Shop\nBangkok")]);
        for bad in [json!({"app": "TextEdit", "element_index": 6, "value": "a\u{7}b"}), json!({"app": "TextEdit", "element_index": 6, "value": "x".repeat(TEXT_CHARS + 1)}), json!({"app": "TextEdit", "element_index": 6})] {
            assert!(matches!(r.ask(SET, &bad), Decision::Refuse(_)), "{bad}");
        }
    }

    /// A control that changed, went, or whose app quit between the yes and the run is not touched.
    #[test]
    fn an_action_touches_only_the_control_the_card_named() {
        let (s, r) = room();
        look(&r, "TextEdit");
        let click = json!({"app": "TextEdit", "element_index": 2});
        let yes = |r: &Room| {
            let a = card(r, CLICK, &click);
            r.answered(CLICK, &click, &a);
        };
        yes(&r);
        s.change(TEXTEDIT, 0, 1, |x| x.label = "Delete".into());
        assert!(r.run(CLICK, &click).text.contains("changed since the person said yes"));
        s.change(TEXTEDIT, 0, 1, |x| x.label = "Save".into());
        // a fresh look renumbers, and a click names an element of the latest look
        look(&r, "TextEdit");
        yes(&r);
        s.remove(TEXTEDIT, 0, 1);
        assert!(r.run(CLICK, &click).text.contains("gone"));
        let (s, r) = room();
        look(&r, "TextEdit");
        yes(&r);
        s.quit(TEXTEDIT);
        assert!(r.run(CLICK, &click).text.contains("no longer open"));
        assert!(s.acts().is_empty());
        // and an element that is not in the latest look is not asked about
        let (_, r) = room();
        assert!(refused(&r, CLICK, &click).contains("Call `get_app_state` for TextEdit first"));
        look(&r, "TextEdit");
        assert!(refused(&r, CLICK, &json!({"app": "TextEdit", "element_index": 99})).contains("no element [99]"));
    }

    /// Nothing is looked at or done while the screen is locked, and a yes waiting then is spent.
    #[test]
    fn nothing_runs_while_the_screen_is_locked() {
        let (s, r) = room();
        look(&r, "TextEdit");
        let click = json!({"app": "TextEdit", "element_index": 2});
        let a = card(&r, CLICK, &click);
        r.answered(CLICK, &click, &a);
        s.lock(true);
        let n = s.calls().len();
        for (tool, args) in [(LIST, json!({})), (LOOK, json!({"app": "TextEdit"})), (CLICK, click.clone())] {
            assert!(refused(&r, tool, &args).contains("locked"), "{tool}");
            let out = r.run(tool, &args);
            assert!(out.error && out.text.contains("locked"), "{tool}");
        }
        assert_eq!(s.calls().len(), n, "the Mac was not read or worked");
        s.lock(false);
        assert_eq!(r.run(CLICK, &click).text, NO_YES, "the yes given before the lock was spent");
        assert!(s.acts().is_empty());
    }

    #[test]
    fn without_accessibility_nothing_is_offered() {
        let s = Arc::new(Stand::new().no_accessibility());
        let r = Room::new(s.clone());
        assert!(refused(&r, LIST, &json!({})).contains("Accessibility"));
        assert!(r.run(LIST, &json!({})).error);
        assert!(s.calls().is_empty());
    }

    #[test]
    fn a_picture_comes_only_with_screen_capture() {
        let (_, r) = room();
        let args = json!({"app": "TextEdit", "picture": true});
        let a = card(&r, LOOK, &args);
        r.answered(LOOK, &args, &a);
        assert_eq!(r.run(LOOK, &args).image.as_deref(), Some(&b"\x89PNG stand-in"[..]));
        assert_eq!(r.run(LOOK, &json!({"app": "TextEdit"})).image, None);
        let s = Arc::new(Stand::new().no_screen());
        let r = Room::new(s.clone());
        let a = card(&r, LOOK, &args);
        r.answered(LOOK, &args, &a);
        let out = r.run(LOOK, &args);
        assert!(out.image.is_none() && out.text.contains("Screen capture"));
        assert!(!s.calls().iter().any(|c| c.starts_with("picture")));
    }

    #[test]
    fn a_key_is_pressed_in_the_window_the_card_named_and_never_a_blocked_shortcut() {
        let (s, r) = room();
        let args = json!({"app": "TextEdit", "key": "cmd+s"});
        let a = card(&r, KEY, &args);
        assert_eq!(a.shown.title(), "Press Cmd+S in TextEdit?");
        assert_eq!(a.shown.lines(), "App: TextEdit\nWindow: Untitled\nKeys: Cmd+S");
        r.answered(KEY, &args, &a);
        assert!(!r.run(KEY, &args).error);
        assert_eq!(s.acts(), [format!("key {TEXTEDIT} Cmd+S")]);
        // the app's front window changed after the yes: the key is not pressed
        let a = card(&r, KEY, &args);
        r.answered(KEY, &args, &a);
        s.focus(TEXTEDIT, "Letter to the bank.rtf");
        assert!(r.run(KEY, &args).text.contains("different window"));
        assert_eq!(s.acts().len(), 1);
        for blocked in ["Cmd+Q", "Cmd+Shift+Q", "Ctrl+Cmd+Q", "Cmd+Option+Escape", "Cmd+Shift+Delete"] {
            assert!(refused(&r, KEY, &json!({"app": "TextEdit", "key": blocked})).contains("never sends it"), "{blocked}");
        }
        assert!(matches!(r.ask(KEY, &json!({"app": "TextEdit", "key": "Return Return"})), Decision::Refuse(_)));
    }

    #[test]
    fn a_menu_item_is_chosen_by_its_path_and_never_from_the_apple_menu() {
        let (s, r) = room();
        let args = json!({"app": "TextEdit", "menu": ["File", "Save…"]});
        let a = card(&r, MENU, &args);
        assert_eq!(a.shown.title(), "Choose File › Save… in TextEdit?");
        r.answered(MENU, &args, &a);
        assert!(!r.run(MENU, &args).error);
        assert_eq!(s.acts(), [format!("menu {TEXTEDIT} File › Save…")]);
        for bad in [json!(["Apple", "System Settings…"]), json!(["\u{F8FF}", "Log Out"]), json!(["File"]), json!(["File", ""]), json!(["File", 3]), json!("File › Save")] {
            assert!(matches!(r.ask(MENU, &json!({"app": "TextEdit", "menu": bad})), Decision::Refuse(_)), "{bad}");
        }
    }

    #[test]
    fn an_app_is_named_by_its_bundle_or_its_name_and_an_unknown_one_is_said() {
        let (_, r) = room();
        assert!(refused(&r, LOOK, &json!({"app": "Photoshop"})).contains("list_windows"));
        assert!(refused(&r, LOOK, &json!({})).contains("Name the app"));
        assert!(matches!(r.ask(LOOK, &json!({"app": " com.apple.textedit "})), Decision::Card(_)));
        assert!(refused(&r, "run_shell", &json!({"app": "TextEdit"})).contains("not a computer use tool"));
        assert!(r.run("run_shell", &json!({})).error);
    }

    #[test]
    fn roles_read_as_words() {
        assert_eq!(role_words("AXTextArea"), "text area");
        assert_eq!(role_words("AXButton"), "button");
        assert_eq!(role_words(""), "element");
    }
}
