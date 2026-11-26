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
//! What an app says about itself is the app's own words, and a web page in an allowed browser chooses its controls' names
//! freely. So every name, title and value shown or compared is first stripped of invisible format characters
//! ([`clean`]), text to type that holds any is refused, the card says that a control's name comes from the app, and a
//! yes is bound to more than the name: the control's window, its place in that window's tree and its position and size
//! on screen at the moment of the ask ([`Place`]), checked again just before acting.
//!
//! Never, for a look or an action: Manut AI's own windows and web pages, in any app (an agent must not read or answer
//! its own asks: [`own_window`]), System Settings, the places macOS keeps passwords (Keychain Access, Passwords) and the prompts where macOS asks for a
//! password, a fingerprint or a permission ([`REFUSED`]); what a password field holds; anything while the screen is
//! locked or another person's session is in front.

use std::any::Any;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use super::keys::{self, Chord, Keyboard};

/// A control on the Mac, as the desk holds it (an accessibility element there, a number in a test).
pub type Handle = Arc<dyn Any + Send + Sync>;

/// A running app with at least one window.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct App {
    pub pid: i32,
    pub name: String,
    /// Its bundle identifier, or empty when it has none.
    pub bundle: String,
    /// The program file it runs, or empty when that cannot be read.
    pub path: String,
    /// It runs as this user (its real and effective user both).
    pub mine: bool,
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
    /// The address it shows, as the app gives it: a web area's page (`AXURL`), a window's document (`AXDocument`).
    pub address: Option<String>,
    pub handle: Handle,
}

impl Node {
    /// A password field: macOS marks it with the secure text field role or subrole.
    pub fn secure(&self) -> bool {
        self.role == SECURE || self.subrole == SECURE
    }
}

/// Where a control is, as the Mac says now: what a yes is bound to besides the control's role and name, because a web
/// page can keep those while it changes what the control does. An action whose control moved or changed place since the
/// ask is refused and asked again. It cannot see a page change what a click does while keeping all of these; the card
/// says that a control's name is the app's own.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Place {
    /// The number of the window it is in (`_AXUIElementGetWindow`), when the Mac says it.
    pub window: Option<u32>,
    /// Its index among its siblings at each level, from the window down.
    pub path: Vec<usize>,
    /// Its position and size on screen in whole points (x, y, width, height), when the Mac says them.
    pub frame: Option<[i64; 4]>,
}

/// A window as the Mac says it is now.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Win {
    /// Its number (`_AXUIElementGetWindow`), which stays the window's own while its title changes; None when the Mac
    /// does not say it.
    pub number: Option<u32>,
    pub title: String,
    /// The addresses it shows where the control is: the window's document (`AXDocument`) and the page of each web area
    /// that holds the control (`AXURL`), as the app gives them.
    pub addresses: Vec<String>,
}

/// Where an app's key presses go now, as the Mac says: the window that has the keyboard, and the control focused in
/// it with its place, or None when the window itself has the focus.
#[derive(Clone)]
pub struct Focus {
    pub window: Win,
    pub control: Option<(Node, Place)>,
}

/// The ranges of Unicode's general category Cf (format characters: the bidi embeddings, overrides, marks and isolates,
/// zero-width spaces and joiners, the byte order mark, tags and the rest), as Unicode 18.0 lists them (read from Node's
/// ICU on 25 Nov 2026 with `/\p{Cf}/u`).
const FORMAT: [(char, char); 21] = [
    ('\u{AD}', '\u{AD}'),
    ('\u{600}', '\u{605}'),
    ('\u{61C}', '\u{61C}'),
    ('\u{6DD}', '\u{6DD}'),
    ('\u{70F}', '\u{70F}'),
    ('\u{890}', '\u{891}'),
    ('\u{8E2}', '\u{8E2}'),
    ('\u{180E}', '\u{180E}'),
    ('\u{200B}', '\u{200F}'),
    ('\u{202A}', '\u{202E}'),
    ('\u{2060}', '\u{2064}'),
    ('\u{2066}', '\u{206F}'),
    ('\u{FEFF}', '\u{FEFF}'),
    ('\u{FFF9}', '\u{FFFB}'),
    ('\u{110BD}', '\u{110BD}'),
    ('\u{110CD}', '\u{110CD}'),
    ('\u{13430}', '\u{1343F}'),
    ('\u{1BCA0}', '\u{1BCA3}'),
    ('\u{1D173}', '\u{1D17A}'),
    ('\u{E0001}', '\u{E0001}'),
    ('\u{E0020}', '\u{E007F}'),
];

/// An invisible format character (general category Cf), which can make text read otherwise than it is.
pub fn format_char(c: char) -> bool {
    FORMAT.iter().any(|(a, b)| (*a..=*b).contains(&c))
}

/// `t` without its invisible format characters: what an app says, as a card or the tree may show it.
pub fn clean(t: &str) -> String {
    t.chars().filter(|c| !format_char(*c)).collect()
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
    /// Where the control is now (its window's number, its place in the window's tree, its frame), or None when that
    /// cannot be told.
    fn place(&self, handle: &Handle) -> Option<Place>;
    /// The window the control is in now, its title and the addresses it shows there, or None when that cannot be told.
    fn window_of(&self, handle: &Handle) -> Option<Win>;
    /// A PNG picture of the part of window `place.window` that `place.frame` covers: the control as it looks.
    fn snapshot(&self, place: &Place) -> Result<Vec<u8>, String>;
    /// Where the app's key presses go now: the window that has the keyboard and the control focused in it, or None when
    /// that cannot be told.
    fn focus(&self, pid: i32) -> Option<Focus>;
    fn press(&self, handle: &Handle) -> Result<(), String>;
    fn set_value(&self, handle: &Handle, text: &str) -> Result<(), String>;
    /// The keyboard layout in use and the others the person has turned on, read fresh (`keys.rs`).
    fn keyboard(&self) -> Result<Keyboard, String>;
    /// Presses `chord` as the key with virtual key code `code`, found on the layout in use ([`Chord::code`]).
    fn key(&self, pid: i32, chord: &Chord, code: u16) -> Result<(), String>;
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
/// The largest control a card shows a picture of, in points, and the largest picture: a small likeness, not a window.
const CARD_PICTURE_POINTS: (i64, i64) = (640, 320);
const CARD_PICTURE_BYTES: usize = 256 * 1024;
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
/// "open anyway", with the two helpers that draw the password and Touch ID sheets (XPC services, which the rule in
/// [`refused`] for macOS's own programs covers too).
pub const REFUSED: [(&str, &str); 15] = [
    ("com.apple.systempreferences", "System Settings"),
    ("com.apple.keychainaccess", "Keychain Access, where macOS keeps passwords"),
    ("com.apple.Passwords", "Passwords, where macOS keeps passwords"),
    ("com.apple.security.Keychain-Circle-Notification", "a keychain prompt"),
    ("com.apple.loginwindow", "the login and lock screen"),
    ("com.apple.ScreenSaver.Engine", "the screen saver"),
    ("com.apple.SecurityAgent", "a password prompt"),
    ("com.apple.LocalAuthentication.UIAgent", "a Touch ID or password prompt"),
    ("com.apple.LocalAuthenticationRemoteService", "a Touch ID or password prompt"),
    ("com.apple.SecurityAgentHelper.arm64", "a password prompt"),
    ("com.apple.SecurityAgentHelper.x86_64", "a password prompt"),
    ("com.apple.tcc.AuthorizationPromptService", "a permission prompt"),
    ("com.apple.accessibility.universalAccessAuthWarn", "the Accessibility permission prompt"),
    ("com.apple.UserNotificationCenter", "a system alert"),
    ("com.apple.coreservices.uiagent", "a prompt about opening an app or file"),
];

/// Why Manut AI's own windows and pages are never looked at or worked.
const OWN: &str = "Manut AI's own windows and pages, where you are asked before anything acts";

/// Another copy of Manut AI, which shows asks as this one does: a bundle identifier of Manut AI's (`xyz.manut.`), a
/// name that is Manut AI's, or its program (`manut`, as a build that is not a bundle runs it).
fn own_program(app: &App) -> bool {
    let bundle = app.bundle.to_ascii_lowercase();
    let name = clean(&app.name).trim().to_lowercase();
    let program = app.path.rsplit('/').next().unwrap_or("").to_ascii_lowercase();
    bundle == OWN_BUNDLE || bundle.starts_with("xyz.manut.") || name == "manut" || name.contains("manut ai") || program == "manut"
}

/// The titles Manut AI's own windows and web pages set (`apps/desktop/index.html`, and each page's `documentTitle` in
/// `apps/web/src/{approve,delete,join,app}/strings.ts`, the web being English only), lowercased: a window whose title
/// holds any of them shows where the person answers an ask.
const OWN_TITLES: [&str; 4] = ["manut ai", "approve a reply", "delete your shop's data", "join a shop"];

/// The host Manut AI's web pages are served from (`WEB_ORIGIN`, `apps/api/wrangler.jsonc`), and its subdomains.
const OWN_HOST: &str = "manut.xyz";

/// The paths of the pages that answer an ask with a link alone (`apps/web/src/router.tsx`): approve a reply, delete the
/// shop's data, join a shop. On any host, since a page can be served from a preview or from this Mac while developing.
const LINK_PATHS: [&str; 3] = ["/approve/", "/delete/", "/join/"];

/// Whether `address` is one of Manut AI's own web pages: any page of its host, or a link page on any host.
pub fn own_address(address: &str) -> bool {
    let a = clean(address).trim().to_ascii_lowercase();
    let rest = a.split_once("://").map_or(a.as_str(), |(_, r)| r);
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, path) = rest.split_at(end);
    let host = authority.rsplit('@').next().unwrap_or("").split(':').next().unwrap_or("").trim_end_matches('.');
    if host == OWN_HOST || host.ends_with(&format!(".{OWN_HOST}")) {
        return true;
    }
    let path = path.split(['?', '#']).next().unwrap_or("");
    LINK_PATHS.iter().any(|p| path.starts_with(p) && path.len() > p.len())
}

/// Whether a window shows one of Manut AI's own windows or pages, where the person answers what agents ask: by a page
/// address it shows, or, for a browser that gives no address, by the title those pages set.
pub fn own_window(title: &str, addresses: &[String]) -> bool {
    let t = clean(title).to_lowercase().replace('\u{2019}', "'");
    OWN_TITLES.iter().any(|o| t.contains(o)) || addresses.iter().any(|a| own_address(a))
}

/// `t` with the secret part of any link to a page that answers an ask by itself taken out (`/approve/<token>` reads
/// `/approve/…`): such a link approves, deletes or joins for whoever opens it, so an agent never reads one.
pub fn hide_links(t: &str) -> String {
    let lower = t.to_ascii_lowercase();
    let mut out = String::with_capacity(t.len());
    let mut at = 0;
    while let Some(start) = LINK_PATHS.iter().filter_map(|p| lower[at..].find(p).map(|i| at + i + p.len())).min() {
        out.push_str(&t[at..start]);
        let end = t[start..].find(|c: char| !(c.is_ascii_alphanumeric() || "-._~%".contains(c))).map_or(t.len(), |e| start + e);
        if end > start {
            out.push('…');
        }
        at = end;
    }
    out.push_str(&t[at..]);
    out
}

/// Where macOS keeps its own programs: its sealed system volume and the folders under it that the person cannot change.
/// `/usr/local/` is the person's.
fn of_macos(path: &str) -> bool {
    ["/System/", "/usr/", "/bin/", "/sbin/", "/Library/Apple/"].iter().any(|p| path.starts_with(p)) && !path.starts_with("/usr/local/")
}

/// The folders where macOS keeps the apps a person opens themselves (Safari's is on the app cryptex, as this Mac runs it,
/// and the same seen through the Preboot volume).
const MACOS_APPS: [&str; 5] = [
    "/System/Applications/",
    "/System/Applications/Utilities/",
    "/System/Cryptexes/App/System/Applications/",
    "/System/Volumes/Preboot/Cryptexes/App/System/Applications/",
    "/System/Library/CoreServices/Applications/",
];

/// The Finder, the one app a person opens that macOS keeps among its own services.
const FINDER: &str = "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder";

/// `path` is the program of an app a person opens from one of macOS's Applications folders, or the Finder: an `.app`
/// right in one of those folders, its program right in its `Contents/MacOS`, nothing nested and nothing doubled.
fn macos_app(path: &str) -> bool {
    path == FINDER
        || MACOS_APPS.iter().any(|dir| {
            path.strip_prefix(dir).is_some_and(|rest| {
                let parts: Vec<&str> = rest.split('/').collect();
                matches!(parts.as_slice(), [app, "Contents", "MacOS", program] if app.len() > 4 && app.ends_with(".app") && !program.is_empty())
            })
        })
}

/// Why computer use stays away from `app`, or None when it may look at it. Besides Manut AI and the list above: any
/// window of a program that does not run as this person (the login window, and macOS's prompts that run as the system),
/// any of a program that cannot be read, and any of a program of macOS that is not an app a person opens from one of its
/// Applications folders (its prompts, alerts, agents and helpers, whatever kind of bundle they are and whatever they
/// are called), so a prompt this list does not name yet is still left alone. SecurityAgentHelper and
/// LocalAuthenticationRemoteService, which draw the password and Touch ID sheets, run as the person from XPC services
/// with bundle identifiers, which is why the rule is where a program runs and not what it lacks.
pub fn refused(app: &App, own_pid: i32) -> Option<String> {
    if app.pid == own_pid || own_program(app) {
        return Some(OWN.into());
    }
    if let Some((_, why)) = REFUSED.iter().find(|(b, _)| app.bundle.eq_ignore_ascii_case(b)) {
        return Some((*why).to_string());
    }
    if !app.mine {
        return Some("a window of a program that does not run as you, such as the login window or a macOS prompt".into());
    }
    if app.path.is_empty() || (of_macos(&app.path) && !macos_app(&app.path)) {
        return Some("a window of macOS itself that is not an app you open, such as one of its prompts, alerts or helpers".into());
    }
    None
}

/// What a card shows, as the page draws it in the person's language (`tool.computer` on the ask).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Shown {
    /// `look`, `click`, `set` (typing into an empty field), `replace` (typing in place of everything a field holds),
    /// `key` or `menu`.
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
    /// For `replace`, how many characters the field holds at the ask, all of which the text takes the place of.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaces: Option<usize>,
    /// A small picture of the control at the moment of the ask, a PNG in base64, when Screen capture is on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picture: Option<String>,
}

impl Shown {
    /// The card's title, in English: the page puts it in the person's language from the fields above.
    pub fn title(&self) -> String {
        match self.act {
            "look" => format!("Let the agent look at {} in this chat?", self.app),
            "click" => format!("Click {} in {}?", self.control.as_deref().unwrap_or("a control"), self.app),
            "set" => format!("Type into {} in {}?", self.control.as_deref().unwrap_or("a field"), self.app),
            "replace" => format!("Replace everything in {} ({}) in {}?", self.control.as_deref().unwrap_or("a field"), characters(self.replaces.unwrap_or(0)), self.app),
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
        if matches!(self.act, "click" | "set" | "replace") {
            l.push(format!("The control's name is the one {} gives it (a web page names its own controls), so check it is the one you mean.", self.app));
        }
        if let Some(k) = &self.keys {
            l.push(format!("Keys: {k}"));
        }
        if let Some(m) = &self.menu {
            l.push(format!("Menu: {}", m.join(" › ")));
        }
        if let Some(t) = &self.text {
            l.push(if self.act == "replace" { format!("Replace with: {t}") } else { format!("Text: {t}") });
        }
        if self.act == "look" {
            l.push(format!("It may read the text and controls of {}'s windows and take their picture until this chat ends. Never what a password field holds.", self.app));
        }
        l.join("\n")
    }
}

/// `n` characters, in words: "1 character", "10 characters".
fn characters(n: usize) -> String {
    if n == 1 { "1 character".into() } else { format!("{n} characters") }
}

/// What a yes is for: the very control, key or menu item the card named.
#[derive(Clone)]
enum Target {
    App { key: String },
    /// A click, or with `value` the text put into a field and `held` exactly what the field held at the ask (empty for
    /// typing, else all that the text replaces); `place` is where the control was at the ask.
    Node { pid: i32, role: String, label: String, handle: Handle, value: Option<String>, held: Option<String>, place: Place },
    /// A key press, where it was aimed at the ask, and the key that sends it on the layout then in use.
    Key { pid: i32, aim: Aim, chord: Chord, code: u16 },
    Menu { pid: i32, path: Vec<String> },
}

/// Where a key press was aimed at the ask: the window that had the keyboard, by its number and its title, and the
/// control focused in it, by its role, name and place. A key goes only where all of these still hold.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Aim {
    window: Option<u32>,
    title: String,
    control: Option<(String, String, Place)>,
}

impl Aim {
    fn of(f: &Focus) -> Aim {
        Aim { window: f.window.number, title: f.window.title.clone(), control: f.control.as_ref().map(|(n, p)| (n.role.clone(), n.label.clone(), p.clone())) }
    }
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
/// Why a key press is not asked about or sent when the window that has the keyboard cannot be told.
const NO_FOCUS: &str = "Computer use cannot tell which window of the app has the keyboard now, so it does not press a key there. Ask the person to click into the window, or use a control's own action instead.";
/// Why a window that shows one of Manut AI's own windows or pages is never looked at or worked.
const OWN_PAGE: &str = "That window shows one of Manut AI's own windows or pages, where the person answers what agents ask, so computer use never looks at or works it, whatever the person allowed. Ask the person to answer it themselves.";
/// Why a control whose window cannot be told is not touched.
const NO_WINDOW: &str = "Computer use cannot tell which window that control is in now, so it does not touch it. Look again.";
const LOCKED: &str = "The Mac's screen is locked or asleep, or someone else's session is in front, so computer use does nothing now. Ask the person to unlock the Mac and say when.";
const NO_ACCESSIBILITY: &str = "macOS has not given Manut AI Accessibility, so computer use cannot read or work any window. The person turns it on in Manut AI's Settings › Computer.";
/// Why typing into a field whose content cannot be read is not asked about: it would replace what it holds, unseen.
const UNREAD: &str = "Computer use cannot read what that field holds now, so it cannot say whether typing would replace something there, and does not ask. Reach the goal another way, such as the window's own buttons.";
/// Why typing whose field changed after the yes is not done.
const HELD_CHANGED: &str = "The field holds other text than it did when the person said yes, so nothing was typed: typing puts the text in place of everything the field holds. Look again and ask again.";

/// The key an app is allowed under: its bundle identifier, else its name.
fn app_key(app: &App) -> String {
    if app.bundle.is_empty() { app.name.to_lowercase() } else { app.bundle.to_lowercase() }
}

/// `t` cut to `n` characters on one line, without invisible format characters, for a card or a tree.
fn short(t: &str, n: usize) -> String {
    let one = hide_links(&clean(t)).split_whitespace().collect::<Vec<_>>().join(" ");
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

/// Why text that holds an invisible format character is refused.
const INVISIBLE: &str = "The text holds an invisible formatting character (such as a right-to-left mark or a zero-width space), so what the person would read on the card is not exactly what would be typed. Send it without that character.";

/// Text the agent may type: not too long, no control character but a line break or a tab, and no invisible format
/// character, so the person reads on the card exactly what is typed.
fn typed_ok(t: &str) -> Result<(), String> {
    if t.chars().count() > TEXT_CHARS {
        return Err(format!("The text is longer than {TEXT_CHARS} characters."));
    }
    if t.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
        return Err("The text holds a control character that cannot be typed.".into());
    }
    if t.chars().any(format_char) {
        return Err(INVISIBLE.into());
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

    /// The running apps, their names without invisible format characters (an app names itself).
    fn apps(&self) -> Vec<App> {
        self.desk.apps().into_iter().map(|a| App { name: clean(&a.name), bundle: clean(&a.bundle), ..a }).collect()
    }

    /// An app's window titles, without invisible format characters.
    fn windows(&self, pid: i32) -> Result<Vec<String>, String> {
        Ok(self.desk.windows(pid)?.iter().map(|t| clean(t)).collect())
    }

    /// Where an app's keys go now, its window's title and its control's name and value without invisible format
    /// characters; None unless the window that has the keyboard has a number the Mac says, so it is that window and not
    /// another with the same title.
    fn focus(&self, pid: i32) -> Option<Focus> {
        let f = self.desk.focus(pid)?;
        f.window.number?;
        let window = Win { title: clean(&f.window.title), addresses: f.window.addresses.iter().map(|a| clean(a)).collect(), ..f.window };
        Some(Focus { window, control: f.control.map(|(n, p)| (Room::tidy(n), p)) })
    }

    /// A control as the Mac reads it, its name and value without invisible format characters.
    fn tidy(n: Node) -> Node {
        Node { label: clean(&n.label), value: n.value.map(|v| clean(&v)), role: clean(&n.role), subrole: clean(&n.subrole), address: n.address.map(|a| clean(&a)), ..n }
    }

    /// The control read again now, tidied.
    fn again(&self, handle: &Handle) -> Option<Node> {
        self.desk.again(handle).map(Room::tidy)
    }

    /// The window a control is in now, its title and addresses without invisible format characters; an error when it
    /// cannot be told or it shows one of Manut AI's own windows or pages.
    fn window_of(&self, handle: &Handle) -> Result<Win, String> {
        let w = self.desk.window_of(handle).ok_or(NO_WINDOW)?;
        let w = Win { title: clean(&w.title), addresses: w.addresses.iter().map(|a| clean(a)).collect(), ..w };
        if own_window(&w.title, &w.addresses) {
            return Err(OWN_PAGE.into());
        }
        Ok(w)
    }

    /// An error when the window that has the app's keyboard, as far as the Mac can tell, shows one of Manut AI's own
    /// windows or pages: a menu item acts there.
    fn front_not_own(&self, pid: i32) -> Result<(), String> {
        match self.desk.focus(pid) {
            Some(f) if own_window(&f.window.title, &f.window.addresses) => Err(OWN_PAGE.into()),
            _ => Ok(()),
        }
    }

    /// A small picture of the control at `place` for its card, in base64, when Screen capture is on and the control is
    /// small enough to be a likeness rather than a window's content. Nothing when it cannot be had: the card is whole
    /// without it.
    fn card_picture(&self, place: &Place) -> Option<String> {
        let [_, _, w, h] = place.frame?;
        if place.window.is_none() || w < 1 || h < 1 || w > CARD_PICTURE_POINTS.0 || h > CARD_PICTURE_POINTS.1 || !self.desk.screen() {
            return None;
        }
        let png = self.desk.snapshot(place).ok()?;
        (png.len() <= CARD_PICTURE_BYTES).then(|| super::hub::base64(&png))
    }

    /// The running app the agent names, by bundle identifier or name, in any case.
    fn find(&self, args: &Value) -> Result<App, String> {
        let q = text_arg(args, "app").ok_or("Name the app (`app`): its name or bundle identifier, as `list_windows` gives them.")?.trim();
        let apps = self.apps();
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
        let shown = |act| Shown { act, app: app.name.clone(), window: None, control: None, text: None, keys: None, menu: None, replaces: None, picture: None };
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
                let (handle, title) = {
                    let st = self.state.lock().unwrap();
                    let look = st.looks.get(&app.pid).ok_or_else(|| format!("Call `get_app_state` for {} first, then name a control from it.", app.name))?;
                    let n = look.nodes.get(i - 1).ok_or_else(|| format!("There is no element [{i}] in the latest look at {}.", app.name))?;
                    if n.secure() {
                        return Err("Computer use never touches a password field.".into());
                    }
                    (n.handle.clone(), look.title.clone())
                };
                // the control as it is at the moment of the ask, and where: what the card names and the yes is bound to
                let raw = self.desk.again(&handle).ok_or("The control is gone from the window since the look, so nothing is asked. Look again.")?;
                let n = Room::tidy(raw.clone());
                if n.secure() {
                    return Err("Computer use never touches a password field.".into());
                }
                let place = self.desk.place(&handle).ok_or("Computer use cannot tell where that control is on the screen, so it does not ask about it. Look again.")?;
                // the window it is in now, which must not show one of Manut AI's own windows or pages
                self.window_of(&handle)?;
                let mut s = Shown { window: Some(title), control: Some(control_name(&n)), ..shown(if tool == CLICK { "click" } else { "set" }) };
                let mut held = None;
                if tool == SET {
                    let t = args.get("value").and_then(Value::as_str).ok_or("Give the text to put in the field (`value`).")?;
                    typed_ok(t)?;
                    // The Mac puts the text in place of the field's whole value, so what it holds now decides the card:
                    // typing into an empty field, or replacing all of what it holds, said with how much. It is read as
                    // the Mac gives it, before any tidying: an invisible character is still something replaced.
                    let now = raw.value.ok_or(UNREAD)?;
                    let count = now.chars().count();
                    if count > 0 {
                        s.act = "replace";
                        s.replaces = Some(count);
                    }
                    s.text = Some(t.to_string());
                    held = Some(now);
                }
                s.picture = self.card_picture(&place);
                let target = Target::Node { pid: app.pid, role: n.role, label: n.label, handle, value: s.text.clone(), held, place };
                Ok(Decision::Card(Ask { shown: s, target }))
            }
            KEY => {
                let chord = keys::parse(text_arg(args, "key").ok_or("Name the key (`key`), for example \"Return\" or \"Cmd+S\".")?)?;
                if let Some(effect) = chord.blocked() {
                    return Err(format!("{} would {effect}, so computer use never sends it. Reach the goal another way, such as the window's own button or menu item.", chord.shown()));
                }
                // the key that types the chord's character on the layout in use, never read as a blocked shortcut on
                // any layout turned on
                let code = chord.code(&self.desk.keyboard()?)?;
                // the key goes to the window that has the keyboard and the control focused there: the card names both,
                // and the yes is bound to them, not to a title another window can share
                let focus = self.focus(app.pid).ok_or(NO_FOCUS)?;
                if own_window(&focus.window.title, &focus.window.addresses) {
                    return Err(OWN_PAGE.into());
                }
                if focus.control.as_ref().is_some_and(|(n, _)| n.secure()) {
                    return Err("The keyboard is in a password field, and computer use never types into one.".into());
                }
                let s = Shown { window: Some(focus.window.title.clone()), control: focus.control.as_ref().map(|(n, _)| control_name(n)), keys: Some(chord.shown()), ..shown("key") };
                Ok(Decision::Card(Ask { shown: s, target: Target::Key { pid: app.pid, aim: Aim::of(&focus), chord, code } }))
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
                // the card shows the path exactly as it is matched; a menu's own invisible characters are matched without
                if path.iter().any(|p| p.chars().any(format_char)) {
                    return Err("A menu title holds an invisible formatting character, so the card could not show exactly what is chosen. Name it as `get_app_state` or the menu bar shows it, without that character.".into());
                }
                if apple_menu(&path[0]) {
                    return Err("Computer use never chooses from the Apple menu, which reaches System Settings, logging out and shutting down.".into());
                }
                self.front_not_own(app.pid)?;
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
        for app in self.apps().iter().filter(|a| refused(a, own).is_none()) {
            let id = if app.bundle.is_empty() { String::new() } else { format!(" ({})", app.bundle) };
            if allowed.contains(&app_key(app)) {
                let titles = self.windows(app.pid).unwrap_or_default();
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
        let titles = self.windows(app.pid)?;
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
        let mut nodes: Vec<Node> = self.desk.tree(app.pid, w - 1)?.into_iter().map(Room::tidy).collect();
        nodes.truncate(MAX_NODES);
        // a window that shows one of Manut AI's own windows or pages is never read out, by its title or any page in it
        let addresses: Vec<String> = nodes.iter().filter_map(|n| n.address.clone()).collect();
        if own_window(&titles[w - 1], &addresses) {
            return Err(OWN_PAGE.into());
        }
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
        let app = self.apps().into_iter().find(|a| a.pid == pid).ok_or("The app is no longer open, so nothing was done.")?;
        if let Some(why) = refused(&app, self.desk.own_pid()) {
            return Err(format!("Computer use never looks at or works {why}."));
        }
        Ok(app)
    }

    fn act(&self, target: Target) -> Result<Reply, String> {
        match target {
            Target::App { .. } => Err(NO_YES.into()),
            Target::Node { pid, role, label, handle, value, held, place } => {
                let app = self.still_app(pid)?;
                let raw = self.desk.again(&handle).ok_or("The control is gone from the window, so nothing was done. Look again.")?;
                let now = Room::tidy(raw.clone());
                if now.secure() {
                    return Err("Computer use never touches a password field.".into());
                }
                if now.role != role || now.label != label {
                    return Err("The control changed since the person said yes, so nothing was done. Look again and ask again.".into());
                }
                // the same name is not enough: the same window, the same place in its tree, the same spot on screen
                if self.desk.place(&handle).as_ref() != Some(&place) {
                    return Err("The control moved or changed its place in the window since the person said yes, so nothing was done. Look again and ask again.".into());
                }
                self.window_of(&handle)?;
                let name = control_name(&now);
                match value {
                    None => {
                        self.desk.press(&handle)?;
                        Ok(Reply::ok(format!("Clicked {name} in {}. Call `get_app_state` to see what changed.", app.name)))
                    }
                    Some(text) => {
                        // the yes was for the field as it was at the ask: empty to type into, or holding exactly what
                        // the card said the text replaces; a yes to type never covers a field filled since
                        if raw.value != held {
                            return Err(HELD_CHANGED.into());
                        }
                        self.desk.set_value(&handle, &text)?;
                        // read back: an app can take the text, change it or ignore it
                        let back = self.again(&handle).and_then(|n| n.value);
                        let how = if back.as_deref() == Some(text.as_str()) { "it now holds exactly that text" } else { "it does not read back as exactly that text, so check with `get_app_state` before going on" };
                        let did = if held.as_deref().is_some_and(|h| !h.is_empty()) { "Replaced everything in" } else { "Typed into" };
                        Ok(Reply::ok(format!("{did} {name} in {}: {how}.", app.name)))
                    }
                }
            }
            Target::Key { pid, aim, chord, code } => {
                let app = self.still_app(pid)?;
                if chord.blocked().is_some() {
                    return Err("Computer use never sends that shortcut.".into());
                }
                // the layout read again: the same key must still type what the card named, and no layout turned on
                // since may read it as a shortcut that is never sent
                if chord.code(&self.desk.keyboard()?)? != code {
                    return Err("The keyboard layout changed since the person said yes, so the key was not pressed. Look again and ask again.".into());
                }
                let now = self.focus(pid).ok_or(NO_FOCUS)?;
                if own_window(&now.window.title, &now.window.addresses) {
                    return Err(OWN_PAGE.into());
                }
                if now.control.as_ref().is_some_and(|(n, _)| n.secure()) {
                    return Err("The keyboard is in a password field, and computer use never types into one.".into());
                }
                if Aim::of(&now) != aim {
                    return Err(format!("A different window or control of {} has the keyboard now, so the key was not pressed. Look again and ask again.", app.name));
                }
                self.desk.key(pid, &chord, code)?;
                Ok(Reply::ok(format!("Pressed {} in {}. Call `get_app_state` to see what changed.", chord.shown(), app.name)))
            }
            Target::Menu { pid, path } => {
                let app = self.still_app(pid)?;
                self.front_not_own(pid)?;
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
        {"name": SET, "title": "Type into a field", "description": "Puts text into one text field from the latest get_app_state. An empty field is typed into; a field that holds anything has all of it replaced by the text, and the person's card says so and how many characters it holds. Asks the person first, every time. Never a password field.",
         "inputSchema": {"type": "object", "properties": {"app": app, "element_index": element, "value": {"type": "string", "maxLength": TEXT_CHARS}}, "required": ["app", "element_index", "value"]},
         "annotations": {"readOnlyHint": false, "destructiveHint": true}, "_meta": write_meta},
        {"name": KEY, "title": "Press a key", "description": "Presses one key, with modifiers if any (\"Return\", \"Escape\", \"Cmd+S\"), in the control that has the keyboard in the app's focused window. A letter, digit or punctuation mark is the character the key types on the Mac's keyboard layout. Asks the person first, every time. Shortcuts that quit, log out, lock the screen, force quit or empty the Trash are never sent, on any layout.",
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

    /// The card's line that says a control's name is the app's own.
    const NAMED: &str = "The control's name is the one TextEdit gives it (a web page names its own controls), so check it is the one you mean.";

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
        assert_eq!(a.shown, Shown { act: "look", app: "TextEdit".into(), window: None, control: None, text: None, keys: None, menu: None, replaces: None, picture: None });
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
        let app = |bundle: &str, path: &str, mine: bool| App { pid: 9, name: "x".into(), bundle: bundle.into(), path: path.into(), mine };
        for (bundle, _) in REFUSED {
            assert!(super::refused(&app(&bundle.to_uppercase(), "/Applications/x.app/Contents/MacOS/x", true), 1).is_some(), "{bundle}");
        }
        assert!(super::refused(&app("com.apple.Notes", "/System/Applications/Notes.app/Contents/MacOS/Notes", true), 1).is_none());
    }

    /// One yes, one action: a write runs only after the person's Allow once on its own card, exactly as asked, once.
    #[test]
    fn each_action_runs_once_after_its_own_yes_and_never_without_one() {
        let (s, r) = room();
        look(&r, "TextEdit");
        let click = json!({"app": "TextEdit", "element_index": 2});
        let a = card(&r, CLICK, &click);
        assert_eq!(a.shown.title(), "Click button “Save” in TextEdit?");
        assert_eq!(a.shown.lines(), format!("App: TextEdit\nWindow: Untitled\nControl: button “Save”\n{NAMED}"));
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
        assert_eq!(a.shown.lines(), format!("App: TextEdit\nWindow: Untitled\nControl: text field “Name”\n{NAMED}\nText: Mint Shop\nBangkok"));
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
        assert_eq!(s.acts(), [format!("key {TEXTEDIT} Cmd+S 0x01")]);
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

    /// An app names its own controls and windows, and a web page in an allowed browser does so freely. Invisible format
    /// characters (a right-to-left override, a zero-width space) are taken out of everything shown and compared, so a
    /// card cannot read otherwise than what it names, and text to type that holds any is refused: the person sees
    /// exactly what is typed.
    #[test]
    fn invisible_format_characters_are_never_shown_and_never_typed() {
        let (s, r) = room();
        s.change(TEXTEDIT, 0, 1, |x| x.label = "Pay \u{202E}0001 THB\u{202C} now\u{200B}".into());
        let seen = look(&r, "TextEdit").text;
        assert!(seen.contains("[2] button “Pay 0001 THB now”"), "{seen}");
        let click = json!({"app": "TextEdit", "element_index": 2});
        let a = card(&r, CLICK, &click);
        for shown in [a.shown.title(), a.shown.lines(), serde_json::to_string(&a.shown).unwrap()] {
            assert!(!shown.chars().any(|c| matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200B}'..='\u{200F}' | '\u{FEFF}')), "{shown:?}");
        }
        for bad in ["Mint\u{202E}", "a\u{2067}b", "zero\u{200B}width", "\u{FEFF}x", "tag\u{E0041}"] {
            let why = refused(&r, SET, &json!({"app": "TextEdit", "element_index": 6, "value": bad}));
            assert!(why.contains("invisible"), "{bad:?}: {why}");
        }
        // Thai, with its combining vowels and tone marks, and an emoji with its variation selector, type as written
        for ok in ["ร้านมิ้นท์", "สวัสดีค่ะ ☕️"] {
            assert!(matches!(r.ask(SET, &json!({"app": "TextEdit", "element_index": 6, "value": ok})), Decision::Card(_)), "{ok}");
        }
    }

    /// A yes is bound to the control's window, its place in the window's tree and its spot on screen at the moment of the
    /// ask, not only to its role and name, which a web page keeps as it likes: a control that moved, changed its place
    /// or is now in another window is not touched, and the agent asks again.
    #[test]
    fn a_yes_is_bound_to_where_the_control_was_at_the_ask() {
        let click = json!({"app": "TextEdit", "element_index": 2});
        let yes = |r: &Room| {
            let a = card(r, CLICK, &click);
            r.answered(CLICK, &click, &a);
        };
        let edits: [(&str, Box<dyn Fn(&mut crate::computer::stand::Facts)>); 4] = [
            ("moved on screen", Box::new(|x| x.frame[1] += 40)),
            ("resized", Box::new(|x| x.frame[2] = 300)),
            ("another place in the tree, same name", Box::new(|x| x.path = vec![3])),
            ("deeper in the tree, same name", Box::new(|x| x.path = vec![0, 0])),
        ];
        for (what, edit) in edits {
            let (s, r) = room();
            look(&r, "TextEdit");
            yes(&r);
            s.change(TEXTEDIT, 0, 1, edit);
            let out = r.run(CLICK, &click);
            assert!(out.error && out.text.contains("moved or changed its place"), "{what}: {}", out.text);
            assert!(s.acts().is_empty(), "{what}");
            // asked again where it is now, it runs
            yes(&r);
            assert!(!r.run(CLICK, &click).error, "{what}");
        }
        // the name and role are taken as they are at the ask, not at the look
        let (s, r) = room();
        look(&r, "TextEdit");
        s.change(TEXTEDIT, 0, 1, |x| x.label = "Delete all".into());
        assert_eq!(card(&r, CLICK, &click).shown.control.as_deref(), Some("button “Delete all”"));
        // a control that went between the look and the ask is not asked about
        s.remove(TEXTEDIT, 0, 1);
        assert!(refused(&r, CLICK, &click).contains("gone"));
    }

    /// With Screen capture, a click or typing card carries a small picture of the control as it is at the ask; without
    /// it, or for a control as large as a window's content, none, and the card is whole without one.
    #[test]
    fn a_card_shows_a_small_picture_of_the_control_with_screen_capture() {
        let (s, r) = room();
        look(&r, "TextEdit");
        let a = card(&r, CLICK, &json!({"app": "TextEdit", "element_index": 2}));
        assert_eq!(a.shown.picture.as_deref(), Some(super::super::hub::base64(b"\x89PNG control").as_str()));
        assert!(s.calls().contains(&format!("snapshot {} [100, 130, 80, 24]", crate::computer::stand::window_number(TEXTEDIT, 0))));
        assert_eq!(serde_json::to_value(&a.shown).unwrap()["picture"], json!(super::super::hub::base64(b"\x89PNG control")));
        // a key or a menu item has no control to show
        assert!(card(&r, KEY, &json!({"app": "TextEdit", "key": "Return"})).shown.picture.is_none());
        // the text area as large as a document: no picture of its content
        s.change(TEXTEDIT, 0, 2, |x| x.frame = [100, 100, 600, 400]);
        let n = s.calls().len();
        assert!(card(&r, CLICK, &json!({"app": "TextEdit", "element_index": 3})).shown.picture.is_none());
        assert_eq!(s.calls().len(), n, "nothing was captured");
        let s = Arc::new(Stand::new().no_screen());
        let r = Room::new(s.clone());
        look(&r, "TextEdit");
        assert!(card(&r, CLICK, &json!({"app": "TextEdit", "element_index": 2})).shown.picture.is_none());
        assert!(!s.calls().iter().any(|c| c.starts_with("snapshot")));
    }

    /// macOS's password prompt (SecurityAgent) and its Touch ID and password prompt (`coreautha`) run from `.bundle`s,
    /// not `.app`s: refused by their bundle identifiers, and refused anyway when one is not read, as any window of a
    /// program that is part of macOS with no bundle identifier, or of one that does not run as this person.
    #[test]
    fn macos_prompts_are_refused_whatever_kind_of_bundle_they_are() {
        let app = |bundle: &str, path: &str, mine: bool| App { pid: 9, name: "x".into(), bundle: bundle.into(), path: path.into(), mine };
        let agent = "/System/Library/Frameworks/Security.framework/Versions/A/MachServices/SecurityAgent.bundle/Contents/MacOS/SecurityAgent";
        let touch = "/System/Library/Frameworks/LocalAuthentication.framework/Support/coreautha.bundle/Contents/MacOS/coreautha";
        for (bundle, path) in [("com.apple.SecurityAgent", agent), ("com.apple.LocalAuthentication.UIAgent", touch)] {
            assert_eq!(super::refused(&app(bundle, path, true), 1).as_deref(), REFUSED.iter().find(|(b, _)| *b == bundle).map(|(_, w)| *w), "{bundle}");
            // the identifier not read: part of macOS with none
            assert!(super::refused(&app("", path, true), 1).unwrap().contains("macOS itself"), "{path}");
            // running as another user (the system), whatever its identifier
            assert!(super::refused(&app(bundle, path, false), 1).is_some(), "{path}");
        }
        assert!(super::refused(&app("com.apple.TextEdit", "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit", false), 1).unwrap().contains("does not run as you"));
        // a program whose path cannot be read and has no identifier is left alone too
        assert!(super::refused(&app("", "", true), 1).is_some());
        // the person's own program with no bundle (a script's window, say) outside /System stays possible
        assert!(super::refused(&app("", "/Users/k/bin/tool", true), 1).is_none());
        // and through the room: such an app is never offered or looked at
        let (s, r) = room();
        s.add_app(App { pid: 500, name: "SecurityAgent".into(), bundle: String::new(), path: agent.into(), mine: false });
        assert!(refused(&r, LOOK, &json!({"app": "SecurityAgent"})).starts_with("Computer use never looks at or works"));
        assert!(!r.run(LIST, &json!({})).text.contains("SecurityAgent"));
    }

    /// Typing puts the text in place of everything the field holds (the Mac sets the field's value). So a field that
    /// holds anything is a different, stronger card that says so and how much it holds, an empty one is typed into, and
    /// a yes is bound to what the field held at the ask: a yes to type into an empty field never covers it once filled,
    /// and a yes to replace never covers other text.
    #[test]
    fn typing_into_a_field_that_holds_text_says_it_replaces_everything() {
        let (s, r) = room();
        look(&r, "TextEdit");
        // the text area holds "Dear bank," (10 characters)
        let replace = json!({"app": "TextEdit", "element_index": 3, "value": "Thanks!"});
        let a = card(&r, SET, &replace);
        assert_eq!(a.shown.act, "replace");
        assert_eq!(a.shown.title(), "Replace everything in text area (10 characters) in TextEdit?");
        assert_eq!(serde_json::to_value(&a.shown).unwrap()["replaces"], json!(10));
        assert!(a.shown.lines().ends_with("\nReplace with: Thanks!"), "{}", a.shown.lines());
        // an empty field is typed into
        let typing = json!({"app": "TextEdit", "element_index": 6, "value": "Mint"});
        let t = card(&r, SET, &typing);
        assert_eq!((t.shown.act, t.shown.title()), ("set", "Type into text field “Name” in TextEdit?".to_string()));
        assert!(serde_json::to_value(&t.shown).unwrap().get("replaces").is_none());
        // the yes to type, and the field filled before the run: nothing is typed
        r.answered(SET, &typing, &t);
        s.change(TEXTEDIT, 0, 5, |x| x.value = Some("Old name".into()));
        let out = r.run(SET, &typing);
        assert!(out.error && out.text.contains("holds other text"), "{}", out.text);
        // the yes to replace, and the text changed (to as many characters) before the run: nothing is typed
        r.answered(SET, &replace, &a);
        s.change(TEXTEDIT, 0, 2, |x| x.value = Some("Dear Bank.".into()));
        let out = r.run(SET, &replace);
        assert!(out.error && out.text.contains("holds other text"), "{}", out.text);
        assert!(s.acts().is_empty());
        // asked again and allowed, it replaces exactly what the card said
        let a = card(&r, SET, &replace);
        r.answered(SET, &replace, &a);
        assert!(!r.run(SET, &replace).error);
        assert_eq!(s.acts(), [format!("set {TEXTEDIT} 0 2 Thanks!")]);
        // what a field holds counts whole: a lone space, an invisible character, a number, one character
        for (held, n, title) in [(" ", 1, "(1 character)"), ("\u{200B}", 1, "(1 character)"), ("42", 2, "(2 characters)"), ("ร้าน", 4, "(4 characters)")] {
            s.change(TEXTEDIT, 0, 5, |x| x.value = Some(held.into()));
            let a = card(&r, SET, &typing);
            assert_eq!(a.shown.act, "replace", "{held:?}");
            assert_eq!(serde_json::to_value(&a.shown).unwrap()["replaces"], json!(n), "{held:?}");
            assert!(a.shown.title().contains(title), "{held:?}: {}", a.shown.title());
        }
        // a field whose content cannot be read is not asked about: the card could not say what typing replaces
        s.change(TEXTEDIT, 0, 5, |x| x.value = None);
        assert!(refused(&r, SET, &typing).contains("cannot read what"));
    }

    /// macOS's prompts and its helpers are refused by where they run, not only by name: SecurityAgentHelper and
    /// LocalAuthenticationRemoteService run as the person, have bundle identifiers and live under `/System/`, as an
    /// XPC service. A program of macOS is let in only when it is an app a person opens from one of macOS's
    /// Applications folders, or the Finder.
    #[test]
    fn macos_helpers_that_are_not_apps_a_person_opens_are_refused_by_where_they_run() {
        let app = |bundle: &str, path: &str| App { pid: 9, name: "x".into(), bundle: bundle.into(), path: path.into(), mine: true };
        let agent = "/System/Library/Frameworks/Security.framework/Versions/A/MachServices/SecurityAgent.bundle/Contents/XPCServices";
        for (bundle, path) in [
            ("com.apple.SecurityAgentHelper.arm64", format!("{agent}/SecurityAgentHelper-arm64.xpc/Contents/MacOS/SecurityAgentHelper-arm64")),
            ("com.apple.SecurityAgentHelper.x86_64", format!("{agent}/SecurityAgentHelper-x86_64.xpc/Contents/MacOS/SecurityAgentHelper-x86_64")),
            ("com.apple.LocalAuthenticationRemoteService", "/System/Library/PrivateFrameworks/LocalAuthenticationUI.framework/Versions/A/XPCServices/LocalAuthenticationRemoteService.xpc/Contents/MacOS/LocalAuthenticationRemoteService".into()),
            // helpers no list names yet, of every kind a program of macOS comes in
            ("com.apple.example.service", "/System/Library/PrivateFrameworks/Example.framework/XPCServices/Example.xpc/Contents/MacOS/Example".into()),
            ("com.apple.example.extension", "/System/Library/ExtensionKit/Extensions/Example.appex/Contents/MacOS/Example".into()),
            ("com.apple.example.plugin", "/System/Library/CoreServices/Example.bundle/Contents/MacOS/Example".into()),
            ("com.apple.example.nested", "/System/Library/PrivateFrameworks/Example.framework/Versions/A/Resources/Example.app/Contents/MacOS/Example".into()),
            ("com.apple.example.widget", "/System/Applications/Notes.app/Contents/PlugIns/Widget.appex/Contents/MacOS/Widget".into()),
            // macOS's own agents and alerts, which are apps but not ones a person opens
            ("com.apple.notificationcenterui", "/System/Library/CoreServices/NotificationCenter.app/Contents/MacOS/NotificationCenter".into()),
            ("com.apple.controlcenter", "/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter".into()),
            ("com.apple.example.alert", "/System/Library/CoreServices/Example Alert.app/Contents/MacOS/Example Alert".into()),
            ("com.apple.example.safari-agent", "/System/Cryptexes/App/usr/libexec/SafariNotificationAgent".into()),
            ("com.apple.example.protect", "/Library/Apple/System/Library/CoreServices/XProtect.app/Contents/MacOS/XProtect".into()),
            ("com.apple.example.daemon", "/usr/libexec/exampled".into()),
            ("", "/usr/sbin/exampled".into()),
            ("", "/sbin/example".into()),
            // a path that does not read as macOS keeps it is not one, even with an identifier
            ("com.apple.example.doubled", "/System/Applications//Notes.app/Contents/MacOS/Notes".into()),
            ("com.apple.example.unread", String::new()),
        ] {
            assert!(super::refused(&app(bundle, &path), 1).is_some(), "{path}");
        }
        // the apps a person opens from macOS, and every program that is not macOS's, stay possible
        for path in [
            "/System/Applications/Notes.app/Contents/MacOS/Notes",
            "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
            "/System/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari",
            "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder",
            "/System/Library/CoreServices/Applications/Archive Utility.app/Contents/MacOS/Archive Utility",
            "/Applications/Shopee.app/Contents/MacOS/Shopee",
            "/usr/local/bin/tool",
            "/opt/homebrew/bin/python3",
            "/Users/k/bin/tool",
        ] {
            assert!(super::refused(&app("com.example.app", path), 1).is_none(), "{path}");
        }
    }

    /// A key press goes to the window that had the keyboard at the ask, bound to that window itself and not to its
    /// title: another window with the same title, an untitled one, or none the Mac can tell gets no key.
    #[test]
    fn a_key_goes_only_to_the_window_that_had_the_keyboard_at_the_ask() {
        use crate::computer::stand::f;
        let (s, r) = room();
        // a second untitled document
        s.add_window(TEXTEDIT, "Untitled", vec![f("AXWindow", "Untitled"), f("AXTextArea", "")]);
        let args = json!({"app": "TextEdit", "key": "Return"});
        let a = card(&r, KEY, &args);
        r.answered(KEY, &args, &a);
        s.focus_window(TEXTEDIT, Some(2));
        let out = r.run(KEY, &args);
        assert!(out.error, "{}", out.text);
        // no window that can be told: no card, and a yes given before is not used
        s.focus_window(TEXTEDIT, None);
        assert!(matches!(r.ask(KEY, &args), Decision::Refuse(_)));
        s.focus_window(TEXTEDIT, Some(0));
        let a = card(&r, KEY, &args);
        r.answered(KEY, &args, &a);
        s.focus_window(TEXTEDIT, None);
        assert!(r.run(KEY, &args).error);
        // untitled windows: an empty title is no exemption
        s.set_title(TEXTEDIT, 0, "");
        s.set_title(TEXTEDIT, 2, "");
        s.focus_window(TEXTEDIT, Some(0));
        let a = card(&r, KEY, &args);
        r.answered(KEY, &args, &a);
        s.focus_window(TEXTEDIT, Some(2));
        assert!(r.run(KEY, &args).error);
        assert!(s.acts().is_empty());
        // the same window, and the keyboard moved to another control, or the control moved: no key
        s.set_title(TEXTEDIT, 0, "Untitled");
        s.focus_window(TEXTEDIT, Some(0));
        s.focus_control(TEXTEDIT, 0, Some(5));
        let a = card(&r, KEY, &args);
        assert_eq!(a.shown.lines(), "App: TextEdit\nWindow: Untitled\nControl: text field “Name”\nKeys: Return");
        r.answered(KEY, &args, &a);
        s.focus_control(TEXTEDIT, 0, Some(1));
        assert!(r.run(KEY, &args).text.contains("different window or control"));
        s.focus_control(TEXTEDIT, 0, Some(5));
        let a = card(&r, KEY, &args);
        r.answered(KEY, &args, &a);
        s.change(TEXTEDIT, 0, 5, |x| x.frame[1] += 40);
        assert!(r.run(KEY, &args).error);
        // the keyboard in a password field: never a key there, asked or not
        let a = card(&r, KEY, &args);
        r.answered(KEY, &args, &a);
        s.focus_control(TEXTEDIT, 0, Some(3));
        assert!(r.run(KEY, &args).text.contains("password field"));
        assert!(refused(&r, KEY, &args).contains("password field"));
        assert!(s.acts().is_empty());
        // where all of it still holds, the key is pressed
        s.focus_control(TEXTEDIT, 0, Some(5));
        let a = card(&r, KEY, &args);
        r.answered(KEY, &args, &a);
        assert!(!r.run(KEY, &args).error);
        assert_eq!(s.acts(), [format!("key {TEXTEDIT} Return 0x24")]);
    }

    /// Manut AI's own asks are answered in its own windows and on its web pages (approve a reply, delete the shop's
    /// data, join a shop, the owner's web app): an agent must never press Allow on its own ask, whatever the person
    /// allowed. So any window that shows one of them is never looked at or worked, in any app, and another copy of
    /// Manut AI is its own windows too.
    #[test]
    fn manut_ais_own_windows_and_pages_are_refused_wherever_they_show() {
        use crate::computer::stand::{f, SAFARI, SAFARI_PATH};
        let (s, r) = room();
        s.add_app(App { pid: SAFARI, name: "Safari".into(), bundle: "com.apple.Safari".into(), path: SAFARI_PATH.into(), mine: true });
        s.add_window(SAFARI, "Shopee Seller Centre", vec![f("AXWindow", "Shopee Seller Centre"), f("AXButton", "Approve")]);
        assert!(!look(&r, "Safari").error);
        let click = json!({"app": "Safari", "element_index": 2});
        let key = json!({"app": "Safari", "key": "Return"});
        let menu = json!({"app": "Safari", "menu": ["File", "Close Window"]});
        for title in ["Approve a reply", "Delete your shop's data", "Join a shop", "Manut AI", "Approve a reply - Google Chrome", "approve A REPLY", "Approve a\u{200B} reply"] {
            s.set_title(SAFARI, 0, title);
            assert!(r.run(LOOK, &json!({"app": "Safari"})).error, "look {title}");
            for (tool, args) in [(CLICK, &click), (KEY, &key), (MENU, &menu)] {
                assert!(matches!(r.ask(tool, args), Decision::Refuse(_)), "{tool} {title}");
            }
        }
        // a yes given while the window showed a shop is not used once it shows an approval page
        s.set_title(SAFARI, 0, "Shopee Seller Centre");
        look(&r, "Safari");
        for (tool, args) in [(CLICK, &click), (KEY, &key), (MENU, &menu)] {
            let a = card(&r, tool, args);
            r.answered(tool, args, &a);
        }
        s.set_title(SAFARI, 0, "Approve a reply");
        for (tool, args) in [(CLICK, &click), (KEY, &key), (MENU, &menu)] {
            assert!(r.run(tool, args).error, "{tool}");
        }
        assert!(s.acts().is_empty());
        // another copy of Manut AI is its own windows, by its name, its bundle or its program
        let app = |name: &str, bundle: &str, path: &str| App { pid: 9, name: name.into(), bundle: bundle.into(), path: path.into(), mine: true };
        for other in [
            app("Manut AI", "xyz.manut.desktop.dev", "/Users/k/Downloads/Manut AI.app/Contents/MacOS/manut"),
            app("manut", "", "/Users/k/manut-ai/apps/desktop/src-tauri/target/debug/manut"),
            app("Manut\u{200B} AI", "com.example.other", "/Applications/Other.app/Contents/MacOS/Other"),
            app("Helper", "xyz.manut.helper", "/Applications/Helper.app/Contents/MacOS/Helper"),
        ] {
            assert!(super::refused(&other, 1).is_some_and(|w| w.contains("Manut AI")), "{other:?}");
        }
    }

    /// A browser that says which page a window shows is read by that page's address, whatever its title: any page of
    /// Manut AI's host, and a link page (approve, delete, join) on any host. The near misses stay ordinary pages.
    #[test]
    fn manut_ais_own_pages_are_known_by_their_address() {
        use crate::computer::stand::{f, SAFARI, SAFARI_PATH};
        for own in [
            "https://dev.manut.xyz/approve/Abc-123_x",
            "https://manut.xyz/app/",
            "https://staging.manut.xyz/",
            "HTTPS://MANUT.XYZ./delete/t0k3n",
            "https://user@dev.manut.xyz:443/join/x?y=1",
            "http://localhost:5173/approve/tok",
            "https://pages-preview.example/delete/tok#top",
            "https://dev.manut.xyz\u{200B}/approve/x",
        ] {
            assert!(own_address(own), "{own}");
        }
        for other in ["https://evilmanut.xyz/", "https://manut.xyz.example.com/", "https://shopee.co.th/approve", "https://github.com/x/approve/y", "file:///Users/k/approve/x.txt", "https://example.com/?next=/approve/x", ""] {
            assert!(!own_address(other), "{other}");
        }
        // a window whose web area shows an approval page, titled as anything, is never read or worked
        let (s, r) = room();
        s.add_app(App { pid: SAFARI, name: "Safari".into(), bundle: "com.apple.Safari".into(), path: SAFARI_PATH.into(), mine: true });
        let mut page = f("AXWebArea", "Shop");
        page.address = Some("https://shopee.co.th/".into());
        s.add_window(SAFARI, "Shop", vec![f("AXWindow", "Shop"), page, f("AXButton", "Approve")]);
        assert!(!look(&r, "Safari").error);
        let click = json!({"app": "Safari", "element_index": 3});
        let key = json!({"app": "Safari", "key": "Return"});
        let a = card(&r, CLICK, &click);
        r.answered(CLICK, &click, &a);
        s.change(SAFARI, 0, 1, |x| x.address = Some("https://dev.manut.xyz/approve/Abc".into()));
        assert!(r.run(CLICK, &click).text.contains("Manut AI's own"));
        assert!(r.run(LOOK, &json!({"app": "Safari"})).text.contains("Manut AI's own"));
        assert!(matches!(r.ask(CLICK, &click), Decision::Refuse(_)));
        assert!(matches!(r.ask(KEY, &key), Decision::Refuse(_)));
        assert!(s.acts().is_empty());
    }

    /// A link that answers an ask by itself (approve, delete, join) is never read out of any window: its secret part is
    /// taken out of every name, value and title an agent reads.
    #[test]
    fn an_approval_link_is_never_read_out() {
        assert_eq!(hide_links("Open https://dev.manut.xyz/approve/Abc-123_x.y~z%20 now"), "Open https://dev.manut.xyz/approve/… now");
        assert_eq!(hide_links("/DELETE/abc and /join/xyz/"), "/DELETE/… and /join/…/");
        assert_eq!(hide_links("ร้าน /approve/ ok"), "ร้าน /approve/ ok");
        let (s, r) = room();
        s.change(TEXTEDIT, 0, 2, |x| x.value = Some("Approve: https://manut.xyz/approve/S3cr3t-token".into()));
        let seen = look(&r, "TextEdit").text;
        assert!(seen.contains("[3] text area: Approve: https://manut.xyz/approve/…"), "{seen}");
        assert!(!seen.contains("S3cr3t"));
    }

    /// The titles the room knows are the ones Manut AI's own pages set, read from their sources, so a renamed page is not
    /// missed.
    #[test]
    fn every_title_manut_ais_own_pages_set_is_known() {
        let mut titles = Vec::new();
        for src in [
            include_str!("../../../../web/src/approve/strings.ts"),
            include_str!("../../../../web/src/delete/strings.ts"),
            include_str!("../../../../web/src/join/strings.ts"),
            include_str!("../../../../web/src/app/strings.ts"),
        ] {
            titles.extend(src.lines().filter(|l| l.trim_start().starts_with("documentTitle: \"")).map(|l| l.split('"').nth(1).unwrap().to_string()));
        }
        let index = include_str!("../../../index.html");
        titles.push(index.split("<title>").nth(1).and_then(|t| t.split("</title>").next()).unwrap().to_string());
        assert!(titles.len() >= 5, "{titles:?}");
        for t in &titles {
            assert!(own_window(t, &[]), "{t}");
        }
        assert!(!own_window("Shopee Seller Centre", &[]));
    }

    /// A key press is sent by the key that types its character on the layout in use, and the layout is read again just
    /// before it is sent: on a French Mac Cmd+A is the key in the US "Q" place, a layout changed since the yes sends
    /// nothing, and a key some layout turned on reads as Cmd+Q is never sent.
    #[test]
    fn a_key_is_sent_by_the_key_that_types_it_on_the_layout_in_use() {
        use crate::computer::stand::{layout, FRENCH, US};
        let (s, r) = room();
        let (french, us) = (layout("French", &FRENCH), layout("U.S.", &US));
        let only = |l: &crate::computer::keys::Layout| Some(Keyboard { current: l.clone(), others: Vec::new() });
        s.set_keyboard(only(&french));
        let args = json!({"app": "TextEdit", "key": "Cmd+A"});
        let a = card(&r, KEY, &args);
        assert_eq!(a.shown.title(), "Press Cmd+A in TextEdit?");
        r.answered(KEY, &args, &a);
        assert!(!r.run(KEY, &args).error);
        assert_eq!(s.acts(), [format!("key {TEXTEDIT} Cmd+A 0x0C")]);
        // the layout changed between the yes and the run: nothing is pressed
        let a = card(&r, KEY, &args);
        r.answered(KEY, &args, &a);
        s.set_keyboard(only(&us));
        assert!(r.run(KEY, &args).text.contains("keyboard layout changed"));
        // another layout turned on reads French's A key as Q: refused before any card, and a yes given before is not used
        s.set_keyboard(only(&french));
        let a = card(&r, KEY, &args);
        r.answered(KEY, &args, &a);
        s.set_keyboard(Some(Keyboard { current: french.clone(), others: vec![us.clone()] }));
        assert!(r.run(KEY, &args).text.contains("Cmd+Q would quit the app"));
        assert!(refused(&r, KEY, &args).contains("Cmd+Q would quit the app"));
        // a character no key types there, and a layout that cannot be read: no card
        s.set_keyboard(only(&french));
        assert!(refused(&r, KEY, &json!({"app": "TextEdit", "key": "Cmd+1"})).contains("no key types “1”"));
        s.set_keyboard(None);
        assert!(refused(&r, KEY, &args).contains("keyboard layout"));
        assert_eq!(s.acts().len(), 1);
    }

    #[test]
    fn roles_read_as_words() {
        assert_eq!(role_words("AXTextArea"), "text area");
        assert_eq!(role_words("AXButton"), "button");
        assert_eq!(role_words(""), "element");
    }
}
