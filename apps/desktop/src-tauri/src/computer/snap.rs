//! A snapshot of any app (item 104, docs/computer-use.md, "A snapshot of any app"): a key the person sets, pressed in any
//! app, reads that app's front window with computer use's own reader and rules, and opens a new chat whose box holds what
//! was read. The person reads it there, edits it and sends it, or not: nothing reaches an agent before Send.
//!
//! - **Off until the person turns it on.** [`Setting::default`] is off, and no key is registered with macOS until the
//!   person turns it on in Settings › Computer ([`Snap::set`]). The key suggested there ([`SUGGESTED`]) is only shown.
//! - **Two of Control, Option and Command, and a letter or a digit** ([`Keys::parse`]). A key with fewer would take an
//!   app's own shortcut away from every app; a media key would make the plugin start an event tap, which needs a
//!   permission. The shortcuts macOS itself answers that fit the rule are refused by name ([`MACOS`]).
//! - **A key that is taken says so** ([`Status::Taken`]): keys macOS itself answers, as it lists its own shortcuts
//!   that are turned on (`CopySymbolicHotKeys`, the person's changes in Keyboard › Shortcuts included), are never
//!   registered, and keys macOS refuses (the plugin's `RegisterEventHotKey` fails) are not held. Either way the setting
//!   stays as the person chose it and Settings says another app or macOS uses the keys. Another app's own hot key is not
//!   seen: macOS lets several apps register the same one and tells each (`CarbonEvents.h`), so pressing it does both.
//! - **The same reader and the same refusals as computer use's look** ([`take`]): the app that has the keyboard
//!   ([`Desk::front`]), its frontmost window walked to at most [`MAX_NODES`] elements and [`MAX_DEPTH`] levels by the same
//!   desk, and never Manut AI, System Settings, the places macOS keeps passwords, its prompts and helpers
//!   ([`room::refused`]), a window that shows one of Manut AI's own pages ([`room::own_window`]), or what a password
//!   field holds.
//! - **Masked before it leaves the shell.** Every name, title and value loses its invisible format characters, an
//!   approval link loses its token ([`room::hide_links`]) and token-like text becomes `••••` ([`mask_secrets`], the app's
//!   one masker, `packages/mask-secrets/src/secrets.json`), each counted so the draft says how many were hidden; then it
//!   is cut to [`TEXT_MAX`] characters.
//! - **No permission, no surprise.** Without Accessibility nothing is read and the page is told what is missing; nothing
//!   here asks macOS for anything (mod.rs `reading_the_permissions_never_prompts` reads this file too). A picture of the
//!   window comes only when the person turned it on and Screen capture is already allowed.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;

use super::room::{self, clean, hide_links, own_window, role_words, App, Desk, Node, Room, MAX_DEPTH, MAX_NODES};
use crate::tasks::{mask_mark, mask_secrets};

/// The key Settings suggests, which the person can take or change. It is only shown until they turn the snapshot on.
/// Control, Option and Command with M: no shortcut macOS answers, and three modifiers keep it out of apps' own menus.
pub const SUGGESTED: &str = "Control+Option+Command+M";

/// The event the page hears a snapshot on (src/computer/snapshot.ts).
pub const EVENT: &str = "app-snapshot";

/// The most characters of a window's lines a snapshot takes, a value's own cap, and a name's.
pub const TEXT_MAX: usize = 8_000;
pub const VALUE_MAX: usize = 2_000;
pub const NAME_MAX: usize = 200;
/// The deepest a line is indented: a deeper element is still read, at this indent.
const INDENT_MAX: usize = 12;

/// The shortcuts macOS answers itself, or every app's own menus hold, that two modifiers and a letter or digit would
/// otherwise let through: Lock Screen (⌃⌘Q), Look Up (⌃⌘D), Enter Full Screen (⌃⌘F), the Dock's hiding (⌥⌘D), Hide
/// Others (⌥⌘H), Minimize All (⌥⌘M), Close All (⌥⌘W), and Zoom's and Invert Colours' (⌥⌘8, ⌃⌥⌘8). Taking one would
/// take it from macOS or from every app.
pub const MACOS: [&str; 9] = [
    "Control+Command+Q",
    "Control+Command+D",
    "Control+Command+F",
    "Option+Command+D",
    "Option+Command+H",
    "Option+Command+M",
    "Option+Command+W",
    "Option+Command+8",
    "Control+Option+Command+8",
];

/// The virtual key code of each letter and digit, in its place on an ANSI keyboard (`kVK_ANSI_*`, `HIToolbox/Events.h`):
/// where macOS registers a hot key, where global-hotkey 0.8 puts `KeyM` and `Digit1`, and how macOS's own shortcuts are
/// read ([`Hotkeys::macos`]).
const ANSI: [(char, u16); 36] = [
    ('A', 0x00), ('S', 0x01), ('D', 0x02), ('F', 0x03), ('H', 0x04), ('G', 0x05), ('Z', 0x06), ('X', 0x07), ('C', 0x08),
    ('V', 0x09), ('B', 0x0B), ('Q', 0x0C), ('W', 0x0D), ('E', 0x0E), ('R', 0x0F), ('Y', 0x10), ('T', 0x11), ('1', 0x12),
    ('2', 0x13), ('3', 0x14), ('4', 0x15), ('6', 0x16), ('5', 0x17), ('9', 0x19), ('7', 0x1A), ('8', 0x1C), ('0', 0x1D),
    ('O', 0x1F), ('U', 0x20), ('I', 0x22), ('P', 0x23), ('L', 0x25), ('J', 0x26), ('K', 0x28), ('N', 0x2D), ('M', 0x2E),
];

/// Carbon's modifier bits (`Events.h`: `cmdKey`, `shiftKey`, `optionKey`, `controlKey`), and the Fn key's in a symbolic
/// hot key.
const CMD: u32 = 1 << 8;
const SHIFT: u32 = 1 << 9;
const OPTION: u32 = 1 << 11;
const CONTROL: u32 = 1 << 12;
const FN: u32 = 0x20000;

/// Why keys cannot be the snapshot's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Why {
    /// Not modifiers and one key joined by `+`, or a modifier twice.
    Format,
    /// The key is not a letter or a digit.
    Key,
    /// Fewer than two of Control, Option and Command.
    Modifiers,
    /// macOS itself, or every app's menus, use it.
    Macos,
}

/// A key and its modifiers, as the person set them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Keys {
    pub control: bool,
    pub option: bool,
    pub shift: bool,
    pub command: bool,
    /// An ASCII capital letter or a digit.
    pub key: char,
}

impl Keys {
    /// `text` as keys (`Control+Option+Command+M`; `Ctrl`, `Alt`, `Cmd` and the symbols ⌃ ⌥ ⇧ ⌘ read too), or why it
    /// cannot be the snapshot's.
    pub fn parse(text: &str) -> Result<Keys, Why> {
        let mut k = Keys { control: false, option: false, shift: false, command: false, key: ' ' };
        // a menu's own spelling, `⌃⌥⌘M`, read as words
        let text = text.replace('⌃', "Control+").replace('⌥', "Option+").replace('⇧', "Shift+").replace('⌘', "Command+").replace("++", "+");
        let parts: Vec<&str> = text.split('+').map(str::trim).collect();
        let Some((last, mods)) = parts.split_last() else { return Err(Why::Format) };
        for m in mods {
            let flag = match m.to_ascii_lowercase().as_str() {
                "control" | "ctrl" => &mut k.control,
                "option" | "alt" => &mut k.option,
                "shift" => &mut k.shift,
                "command" | "cmd" => &mut k.command,
                _ => return Err(Why::Format),
            };
            if *flag {
                return Err(Why::Format);
            }
            *flag = true;
        }
        let mut chars = last.chars();
        let c = match (chars.next(), chars.next()) {
            (Some(c), None) => c,
            (None, _) => return Err(Why::Format),
            _ => return Err(Why::Key),
        };
        if !c.is_ascii_alphanumeric() {
            return Err(Why::Key);
        }
        k.key = c.to_ascii_uppercase();
        if [k.control, k.option, k.command].iter().filter(|b| **b).count() < 2 {
            return Err(Why::Modifiers);
        }
        if MACOS.contains(&k.text().as_str()) {
            return Err(Why::Macos);
        }
        Ok(k)
    }

    /// The keys as they are kept: the modifiers in the Mac's order (Control, Option, Shift, Command), then the key.
    pub fn text(&self) -> String {
        let mut out: Vec<String> = [(self.control, "Control"), (self.option, "Option"), (self.shift, "Shift"), (self.command, "Command")]
            .iter()
            .filter(|(on, _)| *on)
            .map(|(_, n)| (*n).to_string())
            .collect();
        out.push(self.key.to_string());
        out.join("+")
    }

    /// The keys as a Mac's menus show them: `⌃⌥⌘M`.
    pub fn shown(&self) -> String {
        let mut out = String::new();
        for (on, s) in [(self.control, '⌃'), (self.option, '⌥'), (self.shift, '⇧'), (self.command, '⌘')] {
            if on {
                out.push(s);
            }
        }
        out.push(self.key);
        out
    }

    /// The keys as macOS names a hot key: the key's virtual key code and Carbon's modifier bits.
    pub fn carbon(&self) -> (u16, u32) {
        let code = ANSI.iter().find(|(c, _)| *c == self.key).map_or(u16::MAX, |(_, k)| *k);
        let mods = [(self.control, CONTROL), (self.option, OPTION), (self.shift, SHIFT), (self.command, CMD)].iter().filter(|(on, _)| *on).fold(0, |m, (_, b)| m | b);
        (code, mods)
    }

    /// Whether macOS answers these keys itself: one of `shortcuts` (its own, turned on, as [`Hotkeys::macos`] reads them)
    /// is this key with exactly these modifiers, and not the Fn key's.
    pub fn macos_uses(&self, shortcuts: &[(u16, u32)]) -> bool {
        let (code, mods) = self.carbon();
        shortcuts.iter().any(|(c, m)| *c == code && m & (CMD | SHIFT | OPTION | CONTROL) == mods && m & FN == 0)
    }

    /// The keys as the global-shortcut plugin reads them (global-hotkey 0.8's `parse_hotkey`): its modifier names and the
    /// key's code, `KeyM` or `Digit1`, never a media key's.
    pub fn accelerator(&self) -> String {
        let mut out: Vec<String> = [(self.control, "Control"), (self.option, "Alt"), (self.shift, "Shift"), (self.command, "Super")]
            .iter()
            .filter(|(on, _)| *on)
            .map(|(_, n)| (*n).to_string())
            .collect();
        out.push(if self.key.is_ascii_digit() { format!("Digit{}", self.key) } else { format!("Key{}", self.key) });
        out.join("+")
    }
}

/// What the person chose in Settings › Computer, kept in `~/.manut/snapshot.json`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Setting {
    /// The key is registered with macOS only while this is on.
    pub on: bool,
    pub keys: String,
    /// Take a picture of the window too, when Screen capture is allowed.
    pub picture: bool,
}

impl Default for Setting {
    fn default() -> Self {
        Setting { on: false, keys: SUGGESTED.into(), picture: false }
    }
}

/// Where the setting is kept.
pub fn file(home: &Path) -> PathBuf {
    home.join(".manut").join("snapshot.json")
}

/// The setting as saved, read tolerantly: a missing or unreadable file, or a field that is not what it should be, reads as
/// the default for it, so anything but a saved `true` leaves the key off.
pub fn load(home: &Path) -> Setting {
    let d = Setting::default();
    let Some(v) = std::fs::read_to_string(file(home)).ok().and_then(|raw| serde_json::from_str::<Value>(&raw).ok()) else { return d };
    Setting {
        on: v.get("on").and_then(Value::as_bool).unwrap_or(false),
        keys: v.get("keys").and_then(Value::as_str).map(str::to_string).unwrap_or(d.keys),
        picture: v.get("picture").and_then(Value::as_bool).unwrap_or(false),
    }
}

/// Keeps the setting, written whole through a file beside it so a crash never leaves half of one.
pub fn save(home: &Path, s: &Setting) -> Result<(), String> {
    let path = file(home);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Where the key stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// Nothing is registered.
    Off,
    /// The key is registered: pressing it in any app takes a snapshot.
    On,
    /// macOS refused the key: another app, or macOS, holds it.
    Taken,
    /// The keys cannot be the snapshot's ([`Why`]); nothing is registered.
    Invalid,
    /// Not here: the snapshot is on the Mac only, and not in the Mac App Store edition, whose sandbox refuses
    /// accessibility.
    Elsewhere,
}

/// What Settings shows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shown {
    pub on: bool,
    pub keys: String,
    /// The keys as a menu shows them, or the text as kept when it is not keys.
    pub shown: String,
    pub picture: bool,
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<Why>,
    pub suggested: String,
    pub suggested_shown: String,
}

/// Registering the key with macOS, behind one interface so the tests use a stand-in: the global-shortcut plugin on the
/// Mac ([`Plugin`]).
pub trait Hotkeys: Send + Sync {
    fn register(&self, accelerator: &str) -> Result<(), String>;
    fn unregister(&self, accelerator: &str) -> Result<(), String>;
    /// macOS's own shortcuts that are turned on, as key codes and Carbon modifiers (`mac.rs` `symbolic_hot_keys`). macOS
    /// lets several apps register the same hot key and tells each of them (`CarbonEvents.h`), so registering keys macOS
    /// answers would not fail: they are found here instead.
    fn macos(&self) -> Vec<(u16, u32)> {
        Vec::new()
    }
}

/// No key is ever registered: the snapshot is not offered here.
pub struct Nowhere;

impl Hotkeys for Nowhere {
    fn register(&self, _: &str) -> Result<(), String> {
        Err("not here".into())
    }
    fn unregister(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
}

/// The global-shortcut plugin (Tauri's, Apache-2.0 OR MIT): on macOS it registers a Carbon hot key, which asks for no
/// permission. Its calls run on the main thread, as macOS requires, and wait for it.
#[cfg(target_os = "macos")]
pub struct Plugin<R: tauri::Runtime>(pub tauri::AppHandle<R>);

#[cfg(target_os = "macos")]
impl<R: tauri::Runtime> Hotkeys for Plugin<R> {
    fn register(&self, accelerator: &str) -> Result<(), String> {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        self.0.global_shortcut().register(accelerator).map_err(|e| e.to_string())
    }
    fn unregister(&self, accelerator: &str) -> Result<(), String> {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        self.0.global_shortcut().unregister(accelerator).map_err(|e| e.to_string())
    }
    fn macos(&self) -> Vec<(u16, u32)> {
        super::mac::symbolic_hot_keys()
    }
}

struct Inner {
    setting: Setting,
    status: Status,
    why: Option<Why>,
    /// The accelerator registered with macOS now, if any.
    registered: Option<String>,
}

/// The snapshot's key: the setting, where it stands, and the one registration.
pub struct Snap {
    home: Option<PathBuf>,
    hot: Box<dyn Hotkeys>,
    /// The snapshot is offered here (the Mac app, not its App Store edition).
    here: bool,
    inner: Mutex<Inner>,
    /// A snapshot is being read: a second press meanwhile does nothing.
    busy: AtomicBool,
}

impl Snap {
    /// The saved setting, its key registered only when it is on. With no home, nothing is saved and the default (off)
    /// holds.
    pub fn start(home: Option<PathBuf>, hot: Box<dyn Hotkeys>, here: bool) -> Snap {
        let setting = home.as_deref().map(load).unwrap_or_default();
        let snap = Snap { home, hot, here, inner: Mutex::new(Inner { setting: Setting::default(), status: Status::Off, why: None, registered: None }), busy: AtomicBool::new(false) };
        snap.apply(setting);
        snap
    }

    /// What the person chose.
    pub fn setting(&self) -> Setting {
        self.inner.lock().unwrap().setting.clone()
    }

    /// What Settings shows.
    pub fn shown(&self) -> Shown {
        let i = self.inner.lock().unwrap();
        let keys = Keys::parse(&i.setting.keys).ok();
        Shown {
            on: i.setting.on,
            keys: i.setting.keys.clone(),
            shown: keys.map_or_else(|| i.setting.keys.clone(), |k| k.shown()),
            picture: i.setting.picture,
            status: i.status,
            why: i.why,
            suggested: SUGGESTED.into(),
            suggested_shown: Keys::parse(SUGGESTED).map(|k| k.shown()).unwrap_or_default(),
        }
    }

    /// The person's change in Settings: kept, then the key registered or let go as it says. A setting that cannot be
    /// kept changes nothing.
    pub fn set(&self, s: Setting) -> Result<Shown, String> {
        if !self.here {
            return Ok(self.shown());
        }
        // the keys as they are kept: what the person typed, in the one order, when they are keys at all
        let s = Setting { keys: Keys::parse(&s.keys).map_or(s.keys.clone(), |k| k.text()), ..s };
        if let Some(home) = &self.home {
            save(home, &s)?;
        }
        self.apply(s);
        Ok(self.shown())
    }

    fn apply(&self, s: Setting) {
        let mut i = self.inner.lock().unwrap();
        if let Some(old) = i.registered.take() {
            let _ = self.hot.unregister(&old);
        }
        let keys = Keys::parse(&s.keys);
        let (status, why) = if !self.here {
            (Status::Elsewhere, None)
        } else {
            match (s.on, keys) {
                (false, k) => (Status::Off, k.err()),
                (true, Err(w)) => (Status::Invalid, Some(w)),
                // keys macOS answers itself are never registered: both would act on one press
                (true, Ok(k)) if k.macos_uses(&self.hot.macos()) => (Status::Taken, None),
                (true, Ok(k)) => match self.hot.register(&k.accelerator()) {
                    Ok(()) => {
                        i.registered = Some(k.accelerator());
                        (Status::On, None)
                    }
                    Err(_) => (Status::Taken, None),
                },
            }
        };
        i.setting = s;
        i.status = status;
        i.why = why;
    }

    /// Starts reading a snapshot, unless one is being read: true when this press may go on.
    pub fn begin(&self) -> bool {
        !self.busy.swap(true, Ordering::SeqCst)
    }

    /// The snapshot was read and handed to the page.
    pub fn end(&self) {
        self.busy.store(false, Ordering::SeqCst);
    }
}

/// What a press of the key took, for the page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Taken {
    /// The front window, read, masked and cut: the new chat's box shows it.
    Snapshot(Snapshot),
    /// macOS has not given Manut AI Accessibility, so nothing was read. The page says so, with the button that opens the
    /// pane; macOS itself is never asked.
    Needs { what: &'static str },
    /// The app in front, or what its window shows, is one computer use never reads.
    #[serde(rename_all = "camelCase")]
    Refused { app: String, own_page: bool },
    /// Nothing could be read: `own` (Manut AI was in front), `noFront` (no app in front could be told), `noWindow` (the
    /// app in front has no window), `locked` (the screen is locked), `unread` (the window could not be read).
    Nothing { why: &'static str },
}

/// A window as a snapshot took it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub app: String,
    pub bundle: String,
    pub window: String,
    /// The window's elements, one a line, indented by depth (`button “Save”`, `text area: Dear bank,`), a value's further
    /// lines under it.
    pub text: String,
    /// How many elements the lines show.
    pub elements: usize,
    /// The window had more than this: elements past [`MAX_NODES`], or lines past [`TEXT_MAX`].
    pub cut: bool,
    /// How many token-like strings became `••••`.
    pub masked: usize,
    /// How many links that answer an ask lost their token.
    pub links: usize,
    /// How many password fields were named and left unread.
    pub secure: usize,
    /// A PNG of the window in base64, when the person asked for pictures and Screen capture is allowed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picture: Option<String>,
    /// A picture was asked for and none was taken (Screen capture is off, or macOS gave none).
    pub no_picture: bool,
}

/// What was hidden from a snapshot, counted.
#[derive(Default)]
struct Hidden {
    masked: usize,
    links: usize,
}

/// `t` made safe to put in a draft: line ends as `\n`, no control character but a line break or a tab, no invisible
/// format character, a link that answers an ask without its token, and token-like text masked, each counted.
fn safe(t: &str, h: &mut Hidden) -> String {
    let t = t.replace("\r\n", "\n").replace('\r', "\n");
    let t: String = clean(&t).chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').collect();
    let linked = hide_links(&t);
    h.links += linked.matches('…').count().saturating_sub(t.matches('…').count());
    let masked = mask_secrets(&linked);
    let mark = mask_mark();
    h.masked += masked.matches(mark).count().saturating_sub(linked.matches(mark).count());
    masked
}

/// `t` on one line, cut to `n` characters with a mark.
fn one_line(t: &str, n: usize) -> String {
    let one = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= n { one } else { format!("{}…", one.chars().take(n - 1).collect::<String>()) }
}

/// `t` cut to `n` characters with a mark, its lines kept, each without trailing blanks, and no empty line.
fn lines_cut(t: &str, n: usize) -> Vec<String> {
    let cut: String = if t.chars().count() <= n { t.to_string() } else { format!("{}…", t.chars().take(n - 1).collect::<String>()) };
    cut.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).map(str::to_string).collect()
}

/// The lines of `nodes` (a window's tree, the window itself first), masked and cut, with what was hidden and whether the
/// cap cut them.
fn lines(nodes: &[Node], h: &mut Hidden) -> (String, usize, usize, bool) {
    let mut out: Vec<String> = Vec::new();
    let (mut size, mut elements, mut secure) = (0usize, 0usize, 0usize);
    for (i, n) in nodes.iter().enumerate() {
        // the window itself: its title heads the snapshot
        if i == 0 && n.role == "AXWindow" {
            continue;
        }
        if n.depth > MAX_DEPTH {
            continue;
        }
        let pad = "  ".repeat(n.depth.saturating_sub(1).min(INDENT_MAX));
        let label = one_line(&safe(&n.label, h), NAME_MAX);
        let mut block = Vec::new();
        if n.secure() {
            // named, and what it holds never read: the desk never asks it, and anything that came is dropped here
            secure += 1;
            let name = if label.is_empty() { String::new() } else { format!(" “{label}”") };
            block.push(format!("{pad}password field{name} (what it holds is never read)"));
        } else {
            let value = n.value.as_deref().filter(|v| !v.trim().is_empty()).map(|v| lines_cut(&safe(v, h), VALUE_MAX)).unwrap_or_default();
            // a static text's title and value are often the same words: said once
            let value = if value.len() == 1 && value[0].trim() == label { Vec::new() } else { value };
            if label.is_empty() && value.is_empty() {
                // a group with no words of its own: its children carry its place by their indent
                continue;
            }
            let mut first = format!("{pad}{}", role_words(&n.role));
            if !label.is_empty() {
                first.push_str(&format!(" “{label}”"));
            }
            match value.split_first() {
                Some((v, rest)) => {
                    first.push_str(&format!(": {v}"));
                    block.push(first);
                    block.extend(rest.iter().map(|l| format!("{pad}  {l}")));
                }
                None => block.push(first),
            }
        }
        let more: usize = block.iter().map(|l| l.chars().count() + 1).sum();
        if size + more > TEXT_MAX {
            return (out.join("\n"), elements, secure, true);
        }
        size += more;
        elements += 1;
        out.extend(block);
    }
    (out.join("\n"), elements, secure, false)
}

/// The app that has the keyboard, and its frontmost window, read as a look reads it and made safe for a draft; or why
/// nothing was read. `picture`: the person asked for a picture of the window too. Nothing here changes anything on the
/// Mac or asks it for a permission.
pub fn take(desk: &dyn Desk, picture: bool) -> Taken {
    if !desk.accessibility() {
        return Taken::Needs { what: "accessibility" };
    }
    if desk.locked() {
        return Taken::Nothing { why: "locked" };
    }
    let Some(pid) = desk.front() else { return Taken::Nothing { why: "noFront" } };
    let own = desk.own_pid();
    if pid == own {
        return Taken::Nothing { why: "own" };
    }
    // the same apps a look may name, with the same refusals: an app with no window is not one
    let Some(app) = desk.apps().into_iter().find(|a| a.pid == pid) else { return Taken::Nothing { why: "noWindow" } };
    let app = App { name: clean(&app.name), bundle: clean(&app.bundle), ..app };
    if room::refused(&app, own).is_some() {
        return Taken::Refused { app: app.name, own_page: false };
    }
    let title = match desk.windows(pid) {
        Ok(t) if !t.is_empty() => clean(&t[0]),
        _ => return Taken::Nothing { why: "noWindow" },
    };
    let Ok(nodes) = desk.tree(pid, 0) else { return Taken::Nothing { why: "unread" } };
    let mut nodes: Vec<Node> = nodes.into_iter().map(Room::tidy).collect();
    let past = nodes.len() >= MAX_NODES;
    nodes.truncate(MAX_NODES);
    // a window that shows one of Manut AI's own windows or pages is never read out, by its title or any page in it
    let addresses: Vec<String> = nodes.iter().filter_map(|n| n.address.clone()).collect();
    if own_window(&title, &addresses) {
        return Taken::Refused { app: app.name, own_page: true };
    }
    let mut h = Hidden::default();
    let window = one_line(&safe(&title, &mut h), NAME_MAX);
    let (text, elements, secure, cut) = lines(&nodes, &mut h);
    let (picture, no_picture) = if !picture {
        (None, false)
    } else if !desk.screen() {
        (None, true)
    } else {
        match desk.picture(pid, 0) {
            Ok(png) => (Some(super::hub::base64(&png)), false),
            Err(_) => (None, true),
        }
    };
    Taken::Snapshot(Snapshot { app: app.name, bundle: app.bundle, window, text, elements, cut: cut || past, masked: h.masked, links: h.links, secure, picture, no_picture })
}

/// The key was pressed: the app in front is read on a thread of its own (the accessibility API waits on that app, up
/// to two seconds a call), then Manut AI comes to the front and the page is handed what was taken. A press while one is
/// read does nothing.
#[cfg(target_os = "macos")]
pub fn pressed<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::{Emitter, Manager};
    let Some(snap) = app.try_state::<Snap>() else { return };
    if !snap.begin() {
        return;
    }
    let picture = snap.setting().picture;
    let app = app.clone();
    std::thread::spawn(move || {
        let taken = take(&super::mac::Mac::new(), picture);
        crate::tray::show_main(&app);
        let _ = app.emit(EVENT, &taken);
        if let Some(snap) = app.try_state::<Snap>() {
            snap.end();
        }
    });
}

/// Settings › Computer reads where the snapshot's key stands.
#[tauri::command]
pub fn snapshot_settings(snap: tauri::State<'_, Snap>) -> Shown {
    snap.shown()
}

/// Settings › Computer changes it: on or off, the keys, a picture or not. Registering runs on the main thread, as a
/// command without `async` does, which is where macOS wants it.
#[tauri::command]
pub fn snapshot_set(snap: tauri::State<'_, Snap>, on: bool, keys: String, picture: bool) -> Result<Shown, String> {
    if keys.chars().count() > 80 {
        return Err("keys too long".into());
    }
    snap.set(Setting { on, keys, picture })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer::stand::{f, Stand, KEYCHAIN, NOTES, OWN, SAFARI, SAFARI_PATH, SETTINGS, TEXTEDIT};
    use std::sync::Arc;

    /// A stand-in for macOS's hot keys: what was registered and let go, in order, and keys it refuses as taken.
    #[derive(Default)]
    struct Keyring {
        calls: Arc<Mutex<Vec<String>>>,
        taken: Vec<String>,
        macos: Vec<(u16, u32)>,
    }

    impl Hotkeys for Keyring {
        fn register(&self, a: &str) -> Result<(), String> {
            if self.taken.iter().any(|t| t == a) {
                return Err(format!("Unable to register hotkey: RegisterEventHotKey failed for {a}"));
            }
            self.calls.lock().unwrap().push(format!("register {a}"));
            Ok(())
        }
        fn unregister(&self, a: &str) -> Result<(), String> {
            self.calls.lock().unwrap().push(format!("unregister {a}"));
            Ok(())
        }
        fn macos(&self) -> Vec<(u16, u32)> {
            self.macos.clone()
        }
    }

    fn keyring(taken: &[&str]) -> (Box<Keyring>, Arc<Mutex<Vec<String>>>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        (Box::new(Keyring { calls: calls.clone(), taken: taken.iter().map(|s| s.to_string()).collect(), macos: Vec::new() }), calls)
    }

    fn home() -> PathBuf {
        let d = std::env::temp_dir().join(format!("manut-snap-{}-{}", std::process::id(), rand_part()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn rand_part() -> u64 {
        use std::sync::atomic::AtomicU64;
        static N: AtomicU64 = AtomicU64::new(0);
        N.fetch_add(1, Ordering::SeqCst)
    }

    fn snapshot(t: Taken) -> Snapshot {
        match t {
            Taken::Snapshot(s) => s,
            other => panic!("not a snapshot: {other:?}"),
        }
    }

    // ---- the key ---------------------------------------------------------------------------------------------------

    /// Off until the person turns it on: the default, a missing file, an unreadable one and one whose `on` is not a
    /// plain true all leave the key off, and starting registers nothing.
    #[test]
    fn the_key_is_off_by_default_and_nothing_is_registered_until_it_is_turned_on() {
        assert_eq!(Setting::default(), Setting { on: false, keys: SUGGESTED.into(), picture: false });
        let h = home();
        assert_eq!(load(&h), Setting::default(), "no file");
        std::fs::create_dir_all(h.join(".manut")).unwrap();
        for bad in ["", "{", "[]", "null", "{\"on\": \"yes\"}", "{\"on\": 1}", "{\"picture\": true}"] {
            std::fs::write(file(&h), bad).unwrap();
            assert!(!load(&h).on, "{bad}");
        }
        assert!(load(&h).picture, "a picture saved on is read on");
        std::fs::remove_file(file(&h)).unwrap();
        let (keys, calls) = keyring(&[]);
        let snap = Snap::start(Some(h.clone()), keys, true);
        assert!(calls.lock().unwrap().is_empty(), "nothing is registered at start");
        let shown = snap.shown();
        assert_eq!((shown.on, shown.status, shown.picture), (false, Status::Off, false));
        // the suggestion is shown, never registered
        assert_eq!((shown.suggested.as_str(), shown.suggested_shown.as_str()), ("Control+Option+Command+M", "⌃⌥⌘M"));
        assert_eq!(shown.shown, "⌃⌥⌘M");
        // without a home nothing is kept, and it is off too
        let (keys, calls) = keyring(&[]);
        assert_eq!(Snap::start(None, keys, true).shown().status, Status::Off);
        assert!(calls.lock().unwrap().is_empty());
    }

    /// Turning it on registers exactly the keys, as the plugin reads them; a change lets the old keys go first; off lets
    /// them go. What was chosen is kept, and the next start registers it again.
    #[test]
    fn turning_it_on_registers_the_keys_and_off_lets_them_go() {
        let h = home();
        let (keys, calls) = keyring(&[]);
        let snap = Snap::start(Some(h.clone()), keys, true);
        let s = snap.set(Setting { on: true, keys: "cmd+ctrl+option+m".into(), picture: false }).unwrap();
        assert_eq!((s.status, s.keys.as_str(), s.shown.as_str()), (Status::On, "Control+Option+Command+M", "⌃⌥⌘M"));
        assert_eq!(load(&h), Setting { on: true, keys: "Control+Option+Command+M".into(), picture: false });
        snap.set(Setting { on: true, keys: "Control+Shift+Command+2".into(), picture: true }).unwrap();
        snap.set(Setting { on: false, keys: "Control+Shift+Command+2".into(), picture: true }).unwrap();
        assert_eq!(
            *calls.lock().unwrap(),
            [
                "register Control+Alt+Super+KeyM",
                "unregister Control+Alt+Super+KeyM",
                "register Control+Shift+Super+Digit2",
                "unregister Control+Shift+Super+Digit2",
            ]
        );
        assert_eq!(snap.shown().status, Status::Off);
        // kept on, a start registers it again
        snap.set(Setting { on: true, keys: "Control+Option+Command+M".into(), picture: false }).unwrap();
        let (keys, again) = keyring(&[]);
        assert_eq!(Snap::start(Some(h), keys, true).shown().status, Status::On);
        assert_eq!(*again.lock().unwrap(), ["register Control+Alt+Super+KeyM"]);
    }

    /// Keys macOS refuses say they are taken, and stay chosen: Settings says another app or macOS uses them.
    #[test]
    fn keys_another_app_holds_say_they_are_taken() {
        let (keys, calls) = keyring(&["Control+Alt+Super+KeyM"]);
        let snap = Snap::start(Some(home()), keys, true);
        let s = snap.set(Setting { on: true, keys: SUGGESTED.into(), picture: false }).unwrap();
        assert_eq!((s.on, s.status), (true, Status::Taken));
        assert!(calls.lock().unwrap().is_empty(), "nothing held");
        // other keys are free
        assert_eq!(snap.set(Setting { on: true, keys: "Control+Option+Command+J".into(), picture: false }).unwrap().status, Status::On);
    }

    /// Keys macOS answers itself, as this Mac lists its own shortcuts, are taken: never registered, and Settings says so.
    /// The list below is part of what this Mac read on 27 Nov 2026 (key code, Carbon modifiers): ⌃⌥⇧⌘Q (12, 6912) and
    /// ⌃⌘S (1, 4352), which the rule of two modifiers and a letter would let through, ⌥⌘D, ⌘⇧3 and Spotlight's ⌘Space,
    /// and an Fn shortcut on M.
    #[test]
    fn keys_macos_answers_itself_are_taken_and_never_registered() {
        let this_mac = vec![(12, 6912), (1, 4352), (2, 2304), (20, 768), (49, 256), (46, 0x20000 | 4096 | 2048 | 256)];
        let calls = Arc::new(Mutex::new(Vec::new()));
        let snap = Snap::start(None, Box::new(Keyring { calls: calls.clone(), taken: Vec::new(), macos: this_mac.clone() }), true);
        for keys in ["Control+Option+Shift+Command+Q", "Control+Command+S"] {
            let s = snap.set(Setting { on: true, keys: keys.into(), picture: false }).unwrap();
            assert_eq!(s.status, Status::Taken, "{keys}");
        }
        assert!(calls.lock().unwrap().is_empty(), "nothing registered");
        // the same letter with the Fn key held is another shortcut: ⌃⌥⌘M is free
        assert_eq!(snap.set(Setting { on: true, keys: SUGGESTED.into(), picture: false }).unwrap().status, Status::On);
        assert_eq!(*calls.lock().unwrap(), ["register Control+Alt+Super+KeyM"]);
        // the key codes are the places on the keyboard the stand-in's U.S. layout reads for each letter and digit
        for (code, alone, _) in crate::computer::stand::US {
            if let Some(c) = alone.filter(char::is_ascii_alphanumeric) {
                let k = Keys::parse(&format!("Control+Option+{c}")).unwrap();
                assert_eq!(k.carbon(), (code, CONTROL | OPTION), "{c}");
            }
        }
    }

    /// Only two or more of Control, Option and Command with one letter or digit: anything else, a media key or a
    /// function key among it, is refused before macOS is asked, and so are the shortcuts macOS answers itself.
    #[test]
    fn only_two_modifiers_and_a_letter_or_digit_can_be_the_key() {
        for ok in ["Control+Option+M", "ctrl+cmd+k", "⌃⌥⌘M", "Option+Shift+Command+7", "Control + Command + J"] {
            assert!(Keys::parse(ok).is_ok(), "{ok}");
        }
        let cases = [
            ("", Why::Format),
            ("Command+", Why::Format),
            ("Control+Control+M", Why::Format),
            ("Hyper+Command+M", Why::Format),
            ("M", Why::Modifiers),
            ("Command+M", Why::Modifiers),
            ("Shift+Command+3", Why::Modifiers),
            ("Control+Shift+M", Why::Modifiers),
            ("Control+Option+Space", Why::Key),
            ("Control+Option+F5", Why::Key),
            ("Control+Option+MediaPlayPause", Why::Key),
            ("Control+Option+AudioVolumeUp", Why::Key),
            ("Control+Option+Escape", Why::Key),
            ("Control+Option+é", Why::Key),
            ("Control+Command+Q", Why::Macos),
            ("cmd+ctrl+f", Why::Macos),
            ("Option+Command+8", Why::Macos),
            ("Control+Option+Command+8", Why::Macos),
        ];
        for (text, why) in cases {
            assert_eq!(Keys::parse(text), Err(why), "{text}");
        }
        // what reaches the plugin is a letter's or a digit's code, never a media key's
        for c in ('A'..='Z').chain('0'..='9') {
            let k = Keys::parse(&format!("Control+Option+{c}")).unwrap();
            let a = k.accelerator();
            let key = a.rsplit('+').next().unwrap();
            assert!(key == format!("Key{c}") || key == format!("Digit{c}"), "{a}");
        }
        // refused keys are kept as typed, register nothing, and say why
        let (keys, calls) = keyring(&[]);
        let snap = Snap::start(Some(home()), keys, true);
        let s = snap.set(Setting { on: true, keys: "Command+M".into(), picture: false }).unwrap();
        assert_eq!((s.status, s.why, s.keys.as_str()), (Status::Invalid, Some(Why::Modifiers), "Command+M"));
        assert!(calls.lock().unwrap().is_empty());
    }

    /// Elsewhere (Windows, Linux, the App Store edition) nothing is ever registered and Settings says so.
    #[test]
    fn elsewhere_nothing_is_registered() {
        let (keys, calls) = keyring(&[]);
        let snap = Snap::start(Some(home()), keys, false);
        let s = snap.set(Setting { on: true, keys: SUGGESTED.into(), picture: false }).unwrap();
        assert_eq!(s.status, Status::Elsewhere);
        assert!(calls.lock().unwrap().is_empty());
    }

    /// A second press while a snapshot is read does nothing.
    #[test]
    fn one_snapshot_at_a_time() {
        let snap = Snap::start(None, Box::new(Nowhere), true);
        assert!(snap.begin());
        assert!(!snap.begin());
        snap.end();
        assert!(snap.begin());
    }

    // ---- what it takes --------------------------------------------------------------------------------------------

    /// The front window of the app that has the keyboard: its app, its title, and its elements one a line, indented,
    /// named and with what they hold; never what a password field holds; and nothing on the Mac is changed.
    #[test]
    fn a_snapshot_reads_the_front_window_as_a_look_does() {
        let s = Arc::new(Stand::new());
        let snap = snapshot(take(s.as_ref(), false));
        assert_eq!((snap.app.as_str(), snap.bundle.as_str(), snap.window.as_str()), ("TextEdit", "com.apple.TextEdit", "Untitled"));
        assert_eq!(snap.text, "button “Save”\ntext area: Dear bank,\npassword field “Password” (what it holds is never read)\nbutton “Cancel”\ntext field “Name”");
        assert!(!snap.text.contains("hunter2"));
        assert_eq!((snap.elements, snap.secure, snap.cut, snap.masked, snap.links), (5, 1, false, 0, 0));
        assert_eq!((snap.picture, snap.no_picture), (None, false));
        assert!(s.acts().is_empty(), "nothing acted");
        assert!(!s.calls().iter().any(|c| c.starts_with("picture")), "no picture unless asked");
    }

    /// Without Accessibility nothing is read and the page is told what is missing.
    #[test]
    fn without_accessibility_nothing_is_read_and_the_page_is_told_what_is_needed() {
        let s = Stand::new().no_accessibility();
        assert_eq!(take(&s, true), Taken::Needs { what: "accessibility" });
        assert!(s.calls().is_empty());
        assert_eq!(serde_json::to_value(take(&s, false)).unwrap(), serde_json::json!({"kind": "needs", "what": "accessibility"}));
    }

    /// Manut AI, System Settings, Keychain Access, macOS's own prompts and a window that shows one of Manut AI's pages
    /// are never read, with no tree walked; and nothing at all while the screen is locked or nothing is in front.
    #[test]
    fn refused_windows_are_never_read() {
        let s = Stand::new();
        s.front_app(Some(OWN));
        assert_eq!(take(&s, false), Taken::Nothing { why: "own" });
        for (pid, name) in [(SETTINGS, "System Settings"), (KEYCHAIN, "Keychain Access")] {
            s.front_app(Some(pid));
            assert_eq!(take(&s, false), Taken::Refused { app: name.into(), own_page: false });
        }
        // a prompt of macOS's that is no app a person opens
        s.add_app(App { pid: 700, name: "Prompt".into(), bundle: "com.apple.SecurityAgentHelper.arm64".into(), path: "/System/Library/Frameworks/Security.framework/Versions/A/MachServices/SecurityAgent.bundle/Contents/XPCServices/SecurityAgentHelper.xpc/Contents/MacOS/SecurityAgentHelper".into(), mine: true });
        s.front_app(Some(700));
        assert!(matches!(take(&s, false), Taken::Refused { own_page: false, .. }));
        // an approval page in a browser, by its title and by its address
        s.add_app(App { pid: SAFARI, name: "Safari".into(), bundle: "com.apple.Safari".into(), path: SAFARI_PATH.into(), mine: true });
        s.add_window(SAFARI, "Approve a reply · Manut AI", vec![f("AXWindow", "Approve a reply · Manut AI"), f("AXButton", "Approve")]);
        s.front_app(Some(SAFARI));
        assert_eq!(take(&s, false), Taken::Refused { app: "Safari".into(), own_page: true });
        s.set_title(SAFARI, 0, "Shop");
        s.change(SAFARI, 0, 0, |x| x.address = Some("https://example.com/approve/abc123".into()));
        assert_eq!(take(&s, false), Taken::Refused { app: "Safari".into(), own_page: true });
        // none of the refused apps' windows was walked
        for pid in [OWN, SETTINGS, KEYCHAIN, 700] {
            assert!(!s.calls().iter().any(|c| c.starts_with(&format!("tree {pid} ")) || c.starts_with(&format!("windows {pid}"))), "{pid}: {:?}", s.calls());
        }
        // nothing in front, an app with no window, the screen locked
        s.front_app(None);
        assert_eq!(take(&s, false), Taken::Nothing { why: "noFront" });
        s.front_app(Some(9999));
        assert_eq!(take(&s, false), Taken::Nothing { why: "noWindow" });
        s.front_app(Some(NOTES));
        s.lock(true);
        assert_eq!(take(&s, false), Taken::Nothing { why: "locked" });
        assert!(s.acts().is_empty());
    }

    /// Token-like text is masked and an approval link loses its token before anything leaves the shell, each counted,
    /// in a name, a value and the window's title alike; invisible format characters and control characters go.
    #[test]
    fn secrets_and_approval_links_are_masked_and_counted() {
        let s = Stand::new();
        let key = format!("ghp_{}", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8");
        s.set_title(TEXTEDIT, 0, &format!("notes {key}"));
        s.change(TEXTEDIT, 0, 2, |x| x.value = Some(format!("Dear bank,\r\ntoken={key}\n\nApprove: https://manut.xyz/approve/tok_SECRETSECRET1234 thanks\u{202E}\u{7}")));
        s.change(TEXTEDIT, 0, 1, |x| x.label = format!("Save {key}"));
        let snap = snapshot(take(&s, false));
        let all = format!("{}\n{}", snap.window, snap.text);
        assert!(!all.contains("a1B2c3D4e5F6"), "{all}");
        assert!(!all.contains("SECRETSECRET"), "{all}");
        assert!(!all.contains('\u{202E}') && !all.contains('\u{7}') && !all.contains('\r'), "{all:?}");
        assert_eq!(snap.window, "notes ••••");
        assert!(snap.text.contains("button “Save ••••”"), "{}", snap.text);
        assert!(snap.text.contains("text area: Dear bank,\n  token=••••\n  Approve: https://manut.xyz/approve/… thanks"), "{}", snap.text);
        assert_eq!((snap.masked, snap.links), (3, 1));
    }

    /// An app of its own whose first window holds `controls` (the window first), in front.
    fn app_in_front(s: &Stand, pid: i32, controls: Vec<crate::computer::stand::Facts>) {
        s.add_app(App { pid, name: "Big".into(), bundle: "com.example.big".into(), path: "/Applications/Big.app/Contents/MacOS/Big".into(), mine: true });
        s.add_window(pid, "Big", controls);
        s.front_app(Some(pid));
    }

    /// At most MAX_NODES elements, MAX_DEPTH levels, VALUE_MAX characters a value and TEXT_MAX in all, and the snapshot
    /// says when it was cut.
    #[test]
    fn a_snapshot_is_bounded_in_size_and_depth() {
        // an element past MAX_DEPTH is left out; one at it is read, at the deepest indent
        let s = Stand::new();
        let mut low = f("AXStaticText", "low");
        low.depth = Some(MAX_DEPTH);
        let mut deeper = f("AXStaticText", "deeper");
        deeper.depth = Some(MAX_DEPTH + 1);
        app_in_front(&s, 800, vec![f("AXWindow", "Big"), low, deeper]);
        let snap = snapshot(take(&s, false));
        assert_eq!(snap.text, format!("{}static text “low”", "  ".repeat(INDENT_MAX)));
        assert_eq!((snap.elements, snap.cut), (1, false));

        // a long value is cut to VALUE_MAX
        let s = Stand::new();
        s.change(TEXTEDIT, 0, 2, |x| x.value = Some("word ".repeat(1_000)));
        let snap = snapshot(take(&s, false));
        let area = snap.text.lines().find(|l| l.starts_with("text area")).unwrap();
        assert_eq!(area.chars().count(), "text area: ".len() + VALUE_MAX);
        assert!(area.ends_with('…'));

        // more elements than MAX_NODES: no more than MAX_NODES are read, TEXT_MAX holds, and it says it was cut
        let s = Stand::new();
        let many = std::iter::once(f("AXWindow", "Big")).chain((0..MAX_NODES + 50).map(|i| f("AXButton", &format!("Button number {i}")))).collect();
        app_in_front(&s, 800, many);
        let snap = snapshot(take(&s, false));
        assert!(snap.cut);
        assert!(snap.elements < MAX_NODES);
        assert!(snap.text.chars().count() <= TEXT_MAX);
        assert!(!snap.text.contains(&format!("Button number {}", MAX_NODES + 10)));

        // just under the cap of elements and characters: nothing was cut
        let s = Stand::new();
        app_in_front(&s, 800, (0..20).map(|i| f(if i == 0 { "AXWindow" } else { "AXButton" }, &format!("B{i}"))).collect());
        let snap = snapshot(take(&s, false));
        assert_eq!((snap.elements, snap.cut), (19, false));
    }

    /// A picture only when the person asked for one and Screen capture is already allowed; otherwise the snapshot says
    /// none was taken, and the screen is never captured.
    #[test]
    fn a_picture_only_when_asked_and_screen_capture_is_allowed() {
        let s = Stand::new();
        let snap = snapshot(take(&s, true));
        assert_eq!(snap.picture.as_deref(), Some(crate::computer::hub::base64(b"\x89PNG stand-in").as_str()));
        assert!(!snap.no_picture);
        let s = Stand::new().no_screen();
        let snap = snapshot(take(&s, true));
        assert_eq!((snap.picture, snap.no_picture), (None, true));
        assert!(!s.calls().iter().any(|c| c.starts_with("picture")));
    }

    /// The key is the shell's alone: the page's capability grants none of the global-shortcut plugin's commands, so no
    /// page script can register a key or learn which are held.
    #[test]
    fn the_page_is_given_none_of_the_plugins_commands() {
        let caps: Value = serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap();
        let granted: Vec<&str> = caps["permissions"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert!(!granted.is_empty());
        assert!(granted.iter().all(|p| !p.starts_with("global-shortcut")), "{granted:?}");
    }

    /// What the page hears, in its own names.
    #[test]
    fn what_was_taken_reaches_the_page_in_its_own_names() {
        let v = serde_json::to_value(take(&Stand::new(), false)).unwrap();
        assert_eq!(v["kind"], "snapshot");
        for k in ["app", "bundle", "window", "text", "elements", "cut", "masked", "links", "secure", "noPicture"] {
            assert!(v.get(k).is_some(), "{k}");
        }
        assert!(v.get("picture").is_none());
        assert_eq!(serde_json::to_value(Taken::Refused { app: "Safari".into(), own_page: true }).unwrap(), serde_json::json!({"kind": "refused", "app": "Safari", "ownPage": true}));
        assert_eq!(serde_json::to_value(Taken::Nothing { why: "own" }).unwrap(), serde_json::json!({"kind": "nothing", "why": "own"}));
        let shown = serde_json::to_value(Snap::start(None, Box::new(Nowhere), true).shown()).unwrap();
        assert_eq!(shown, serde_json::json!({"on": false, "keys": SUGGESTED, "shown": "⌃⌥⌘M", "picture": false, "status": "off", "suggested": SUGGESTED, "suggestedShown": "⌃⌥⌘M"}));
    }
}
