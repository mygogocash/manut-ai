//! A stand-in Mac for the tests: a few apps with windows and controls, and a record of everything asked of it. Nothing
//! here touches the real screen.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use super::keys::Chord;
use super::room::{App, Desk, Focus, Handle, Node, Place, Win};

#[derive(Clone)]
pub struct Facts {
    pub role: &'static str,
    pub subrole: &'static str,
    pub label: String,
    pub value: Option<String>,
    pub enabled: bool,
    /// Where it is: its index among its siblings from the window down, and its frame on screen.
    pub path: Vec<usize>,
    pub frame: [i64; 4],
}

pub fn f(role: &'static str, label: &str) -> Facts {
    Facts { role, subrole: "", label: label.into(), value: None, enabled: true, path: Vec::new(), frame: [0, 0, 80, 24] }
}

/// The stand-in window numbers: app `pid`'s window `w` is `pid * 10 + w`.
pub fn window_number(pid: i32, w: usize) -> u32 {
    pid as u32 * 10 + w as u32
}

pub const OWN: i32 = 1;
pub const TEXTEDIT: i32 = 100;
pub const SETTINGS: i32 = 200;
pub const KEYCHAIN: i32 = 300;
pub const NOTES: i32 = 400;
/// A browser the tests add with `add_app`, and where macOS keeps it.
pub const SAFARI: i32 = 600;
pub const SAFARI_PATH: &str = "/System/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari";

/// Keyboard layouts as this Mac's own layout data types each key that types a character: (the key's virtual key code,
/// the character it types alone, the character it types with Command held), read with `UCKeyTranslate` from the
/// layouts' `uchr` data through `TISCreateInputSourceList` on 26 Nov 2026 (macOS 27.2), nothing typed or posted. A
/// French Mac's key in the US "A" place types Q; Dvorak's key in the US "X" place types Q; "Dvorak - QWERTY Command"
/// types Dvorak alone and QWERTY with Command; Thai types Thai alone and QWERTY with Command.
pub const US: [(u16, Option<char>, Option<char>); 48] = [
    (0x00, Some('a'), Some('a')), (0x01, Some('s'), Some('s')), (0x02, Some('d'), Some('d')), (0x03, Some('f'), Some('f')),
    (0x04, Some('h'), Some('h')), (0x05, Some('g'), Some('g')), (0x06, Some('z'), Some('z')), (0x07, Some('x'), Some('x')),
    (0x08, Some('c'), Some('c')), (0x09, Some('v'), Some('v')), (0x0A, Some('\u{A7}'), Some('\u{A7}')), (0x0B, Some('b'), Some('b')),
    (0x0C, Some('q'), Some('q')), (0x0D, Some('w'), Some('w')), (0x0E, Some('e'), Some('e')), (0x0F, Some('r'), Some('r')),
    (0x10, Some('y'), Some('y')), (0x11, Some('t'), Some('t')), (0x12, Some('1'), Some('1')), (0x13, Some('2'), Some('2')),
    (0x14, Some('3'), Some('3')), (0x15, Some('4'), Some('4')), (0x16, Some('6'), Some('6')), (0x17, Some('5'), Some('5')),
    (0x18, Some('='), Some('=')), (0x19, Some('9'), Some('9')), (0x1A, Some('7'), Some('7')), (0x1B, Some('-'), Some('-')),
    (0x1C, Some('8'), Some('8')), (0x1D, Some('0'), Some('0')), (0x1E, Some(']'), Some(']')), (0x1F, Some('o'), Some('o')),
    (0x20, Some('u'), Some('u')), (0x21, Some('['), Some('[')), (0x22, Some('i'), Some('i')), (0x23, Some('p'), Some('p')),
    (0x25, Some('l'), Some('l')), (0x26, Some('j'), Some('j')), (0x27, Some('\''), Some('\'')), (0x28, Some('k'), Some('k')),
    (0x29, Some(';'), Some(';')), (0x2A, Some('\\'), Some('\\')), (0x2B, Some(','), Some(',')), (0x2C, Some('/'), Some('/')),
    (0x2D, Some('n'), Some('n')), (0x2E, Some('m'), Some('m')), (0x2F, Some('.'), Some('.')), (0x32, Some('`'), Some('`')),
];
pub const FRENCH: [(u16, Option<char>, Option<char>); 48] = [
    (0x00, Some('q'), Some('q')), (0x01, Some('s'), Some('s')), (0x02, Some('d'), Some('d')), (0x03, Some('f'), Some('f')),
    (0x04, Some('h'), Some('h')), (0x05, Some('g'), Some('g')), (0x06, Some('w'), Some('w')), (0x07, Some('x'), Some('x')),
    (0x08, Some('c'), Some('c')), (0x09, Some('v'), Some('v')), (0x0A, Some('@'), Some('@')), (0x0B, Some('b'), Some('b')),
    (0x0C, Some('a'), Some('a')), (0x0D, Some('z'), Some('z')), (0x0E, Some('e'), Some('e')), (0x0F, Some('r'), Some('r')),
    (0x10, Some('y'), Some('y')), (0x11, Some('t'), Some('t')), (0x12, Some('&'), Some('&')), (0x13, Some('\u{E9}'), Some('\u{E9}')),
    (0x14, Some('"'), Some('"')), (0x15, Some('\''), Some('\'')), (0x16, Some('\u{A7}'), Some('\u{A7}')), (0x17, Some('('), Some('(')),
    (0x18, Some('-'), Some('-')), (0x19, Some('\u{E7}'), Some('\u{E7}')), (0x1A, Some('\u{E8}'), Some('\u{E8}')), (0x1B, Some(')'), Some(')')),
    (0x1C, Some('!'), Some('!')), (0x1D, Some('\u{E0}'), Some('\u{E0}')), (0x1E, Some('$'), Some('$')), (0x1F, Some('o'), Some('o')),
    (0x20, Some('u'), Some('u')), (0x21, Some('^'), Some('^')), (0x22, Some('i'), Some('i')), (0x23, Some('p'), Some('p')),
    (0x25, Some('l'), Some('l')), (0x26, Some('j'), Some('j')), (0x27, Some('\u{F9}'), Some('\u{F9}')), (0x28, Some('k'), Some('k')),
    (0x29, Some('m'), Some('m')), (0x2A, Some('`'), Some('`')), (0x2B, Some(';'), Some(';')), (0x2C, Some('='), Some('=')),
    (0x2D, Some('n'), Some('n')), (0x2E, Some(','), Some(',')), (0x2F, Some(':'), Some(':')), (0x32, Some('<'), Some('<')),
];
pub const DVORAK: [(u16, Option<char>, Option<char>); 48] = [
    (0x00, Some('a'), Some('a')), (0x01, Some('o'), Some('o')), (0x02, Some('e'), Some('e')), (0x03, Some('u'), Some('u')),
    (0x04, Some('d'), Some('d')), (0x05, Some('i'), Some('i')), (0x06, Some(';'), Some(';')), (0x07, Some('q'), Some('q')),
    (0x08, Some('j'), Some('j')), (0x09, Some('k'), Some('k')), (0x0A, Some('\u{A7}'), Some('\u{A7}')), (0x0B, Some('x'), Some('x')),
    (0x0C, Some('\''), Some('\'')), (0x0D, Some(','), Some(',')), (0x0E, Some('.'), Some('.')), (0x0F, Some('p'), Some('p')),
    (0x10, Some('f'), Some('f')), (0x11, Some('y'), Some('y')), (0x12, Some('1'), Some('1')), (0x13, Some('2'), Some('2')),
    (0x14, Some('3'), Some('3')), (0x15, Some('4'), Some('4')), (0x16, Some('6'), Some('6')), (0x17, Some('5'), Some('5')),
    (0x18, Some(']'), Some(']')), (0x19, Some('9'), Some('9')), (0x1A, Some('7'), Some('7')), (0x1B, Some('['), Some('[')),
    (0x1C, Some('8'), Some('8')), (0x1D, Some('0'), Some('0')), (0x1E, Some('='), Some('=')), (0x1F, Some('r'), Some('r')),
    (0x20, Some('g'), Some('g')), (0x21, Some('/'), Some('/')), (0x22, Some('c'), Some('c')), (0x23, Some('l'), Some('l')),
    (0x25, Some('n'), Some('n')), (0x26, Some('h'), Some('h')), (0x27, Some('-'), Some('-')), (0x28, Some('t'), Some('t')),
    (0x29, Some('s'), Some('s')), (0x2A, Some('\\'), Some('\\')), (0x2B, Some('w'), Some('w')), (0x2C, Some('z'), Some('z')),
    (0x2D, Some('b'), Some('b')), (0x2E, Some('m'), Some('m')), (0x2F, Some('v'), Some('v')), (0x32, Some('`'), Some('`')),
];
pub const DVORAK_QWERTY_CMD: [(u16, Option<char>, Option<char>); 48] = [
    (0x00, Some('a'), Some('a')), (0x01, Some('o'), Some('s')), (0x02, Some('e'), Some('d')), (0x03, Some('u'), Some('f')),
    (0x04, Some('d'), Some('h')), (0x05, Some('i'), Some('g')), (0x06, Some(';'), Some('z')), (0x07, Some('q'), Some('x')),
    (0x08, Some('j'), Some('c')), (0x09, Some('k'), Some('v')), (0x0A, Some('\u{A7}'), Some('\u{A7}')), (0x0B, Some('x'), Some('b')),
    (0x0C, Some('\''), Some('q')), (0x0D, Some(','), Some('w')), (0x0E, Some('.'), Some('e')), (0x0F, Some('p'), Some('r')),
    (0x10, Some('f'), Some('y')), (0x11, Some('y'), Some('t')), (0x12, Some('1'), Some('1')), (0x13, Some('2'), Some('2')),
    (0x14, Some('3'), Some('3')), (0x15, Some('4'), Some('4')), (0x16, Some('6'), Some('6')), (0x17, Some('5'), Some('5')),
    (0x18, Some(']'), Some('=')), (0x19, Some('9'), Some('9')), (0x1A, Some('7'), Some('7')), (0x1B, Some('['), Some('-')),
    (0x1C, Some('8'), Some('8')), (0x1D, Some('0'), Some('0')), (0x1E, Some('='), Some(']')), (0x1F, Some('r'), Some('o')),
    (0x20, Some('g'), Some('u')), (0x21, Some('/'), Some('[')), (0x22, Some('c'), Some('i')), (0x23, Some('l'), Some('p')),
    (0x25, Some('n'), Some('l')), (0x26, Some('h'), Some('j')), (0x27, Some('-'), Some('\'')), (0x28, Some('t'), Some('k')),
    (0x29, Some('s'), Some(';')), (0x2A, Some('\\'), Some('\\')), (0x2B, Some('w'), Some(',')), (0x2C, Some('z'), Some('/')),
    (0x2D, Some('b'), Some('n')), (0x2E, Some('m'), Some('m')), (0x2F, Some('v'), Some('.')), (0x32, Some('`'), Some('`')),
];
pub const THAI: [(u16, Option<char>, Option<char>); 48] = [
    (0x00, Some('\u{E1F}'), Some('a')), (0x01, Some('\u{E2B}'), Some('s')), (0x02, Some('\u{E01}'), Some('d')), (0x03, Some('\u{E14}'), Some('f')),
    (0x04, Some('\u{E49}'), Some('h')), (0x05, Some('\u{E40}'), Some('g')), (0x06, Some('\u{E1C}'), Some('z')), (0x07, Some('\u{E1B}'), Some('x')),
    (0x08, Some('\u{E41}'), Some('c')), (0x09, Some('\u{E2D}'), Some('v')), (0x0A, None, None), (0x0B, Some('\u{E34}'), Some('b')),
    (0x0C, Some('\u{E46}'), Some('q')), (0x0D, Some('\u{E44}'), Some('w')), (0x0E, Some('\u{E33}'), Some('e')), (0x0F, Some('\u{E1E}'), Some('r')),
    (0x10, Some('\u{E31}'), Some('y')), (0x11, Some('\u{E30}'), Some('t')), (0x12, Some('\u{E45}'), Some('1')), (0x13, Some('/'), Some('2')),
    (0x14, Some('_'), Some('3')), (0x15, Some('\u{E20}'), Some('4')), (0x16, Some('\u{E38}'), Some('6')), (0x17, Some('\u{E16}'), Some('5')),
    (0x18, Some('\u{E0A}'), Some('=')), (0x19, Some('\u{E15}'), Some('9')), (0x1A, Some('\u{E36}'), Some('7')), (0x1B, Some('\u{E02}'), Some('-')),
    (0x1C, Some('\u{E04}'), Some('8')), (0x1D, Some('\u{E08}'), Some('0')), (0x1E, Some('\u{E25}'), Some(']')), (0x1F, Some('\u{E19}'), Some('o')),
    (0x20, Some('\u{E35}'), Some('u')), (0x21, Some('\u{E1A}'), Some('[')), (0x22, Some('\u{E23}'), Some('i')), (0x23, Some('\u{E22}'), Some('p')),
    (0x25, Some('\u{E2A}'), Some('l')), (0x26, Some('\u{E48}'), Some('j')), (0x27, Some('\u{E07}'), Some('\'')), (0x28, Some('\u{E32}'), Some('k')),
    (0x29, Some('\u{E27}'), Some(';')), (0x2A, Some('\u{E03}'), Some('\\')), (0x2B, Some('\u{E21}'), Some(',')), (0x2C, Some('\u{E1D}'), Some('/')),
    (0x2D, Some('\u{E37}'), Some('n')), (0x2E, Some('\u{E17}'), Some('m')), (0x2F, Some('\u{E43}'), Some('.')), (0x32, Some('-'), Some('`')),
];

pub struct Stand {
    ax: bool,
    screen: bool,
    locked: AtomicBool,
    apps: Mutex<Vec<App>>,
    windows: Mutex<HashMap<i32, Vec<String>>>,
    nodes: Mutex<HashMap<(i32, usize), Vec<Facts>>>,
    /// Which window of each app has the keyboard, by its index; None for none that can be told. An app not here has
    /// its first window focused.
    focused: Mutex<HashMap<i32, Option<usize>>>,
    /// The control that has the keyboard in each window, by its index; a window not here has the focus itself.
    focused_control: Mutex<HashMap<(i32, usize), usize>>,
    calls: Mutex<Vec<String>>,
}

impl Stand {
    pub fn new() -> Stand {
        let app = |pid, name: &str, bundle: &str| App { pid, name: name.into(), bundle: bundle.into(), path: format!("/Applications/{name}.app/Contents/MacOS/{name}"), mine: true };
        let apps = vec![
            app(OWN, "Manut AI", "xyz.manut.desktop"),
            app(TEXTEDIT, "TextEdit", "com.apple.TextEdit"),
            app(SETTINGS, "System Settings", "com.apple.systempreferences"),
            app(KEYCHAIN, "Keychain Access", "com.apple.keychainaccess"),
            app(NOTES, "Notes", "com.apple.Notes"),
        ];
        let mut windows = HashMap::new();
        windows.insert(OWN, vec!["Manut AI".to_string()]);
        windows.insert(TEXTEDIT, vec!["Untitled".to_string(), "Letter to the bank.rtf".to_string()]);
        windows.insert(SETTINGS, vec!["Privacy & Security".to_string()]);
        windows.insert(KEYCHAIN, vec!["login".to_string()]);
        windows.insert(NOTES, vec!["Groceries".to_string()]);
        let mut nodes = HashMap::new();
        let mut secure = f("AXTextField", "Password");
        secure.subrole = "AXSecureTextField";
        // the stand-in hands back a password field's value, which a real look never reads, so the room's own scrub shows
        secure.value = Some("hunter2".into());
        let mut area = f("AXTextArea", "");
        area.value = Some("Dear bank,".into());
        let mut cancel = f("AXButton", "Cancel");
        cancel.enabled = false;
        // an empty text field holds the empty text, as the Mac reads one
        let mut name = f("AXTextField", "Name");
        name.value = Some(String::new());
        nodes.insert((TEXTEDIT, 0), vec![f("AXWindow", "Untitled"), f("AXButton", "Save"), area, secure, cancel, name]);
        nodes.insert((TEXTEDIT, 1), vec![f("AXWindow", "Letter to the bank.rtf")]);
        nodes.insert((NOTES, 0), vec![f("AXWindow", "Groceries"), f("AXButton", "New Note")]);
        nodes.insert((OWN, 0), vec![f("AXWindow", "Manut AI"), f("AXButton", "Allow once")]);
        nodes.insert((SETTINGS, 0), vec![f("AXWindow", "Privacy & Security"), f("AXCheckBox", "Manut AI")]);
        // each control at its own place: the window is the root, the rest its children in order, one under another
        for list in nodes.values_mut() {
            for (i, x) in list.iter_mut().enumerate() {
                if i > 0 {
                    x.path = vec![i - 1];
                    x.frame = [100, 100 + 30 * i as i64, 80, 24];
                } else {
                    x.frame = [100, 80, 600, 400];
                }
            }
        }
        Stand {
            ax: true,
            screen: true,
            locked: AtomicBool::new(false),
            apps: Mutex::new(apps),
            windows: Mutex::new(windows),
            nodes: Mutex::new(nodes),
            focused: Mutex::new(HashMap::new()),
            focused_control: Mutex::new(HashMap::new()),
            calls: Mutex::new(Vec::new()),
        }
    }

    pub fn no_accessibility(mut self) -> Stand {
        self.ax = false;
        self
    }

    pub fn no_screen(mut self) -> Stand {
        self.screen = false;
        self
    }

    pub fn lock(&self, locked: bool) {
        self.locked.store(locked, Ordering::SeqCst);
    }

    /// Everything asked of the Mac that would read a window or act in one, in order.
    pub fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    /// The actions alone: what changed something on the Mac.
    pub fn acts(&self) -> Vec<String> {
        self.calls().into_iter().filter(|c| ["press", "set", "key", "menu"].iter().any(|v| c.starts_with(v))).collect()
    }

    pub fn change(&self, pid: i32, window: usize, i: usize, edit: impl FnOnce(&mut Facts)) {
        edit(&mut self.nodes.lock().unwrap().get_mut(&(pid, window)).unwrap()[i]);
    }

    pub fn remove(&self, pid: i32, window: usize, i: usize) {
        self.nodes.lock().unwrap().get_mut(&(pid, window)).unwrap().truncate(i);
    }

    /// The app's first window with this title gets the keyboard.
    pub fn focus(&self, pid: i32, title: &str) {
        let w = self.windows.lock().unwrap().get(&pid).and_then(|t| t.iter().position(|x| x == title));
        self.focused.lock().unwrap().insert(pid, w);
    }

    /// Window `w` of the app gets the keyboard, or with None no window the Mac can tell.
    pub fn focus_window(&self, pid: i32, w: Option<usize>) {
        self.focused.lock().unwrap().insert(pid, w);
    }

    /// Control `i` of window `w` of app `pid` has the keyboard there, or with None the window itself.
    pub fn focus_control(&self, pid: i32, w: usize, i: Option<usize>) {
        let mut f = self.focused_control.lock().unwrap();
        match i {
            Some(i) => f.insert((pid, w), i),
            None => f.remove(&(pid, w)),
        };
    }

    /// Another window for app `pid`, its controls laid out as the first window's are: the root, then one under another.
    pub fn add_window(&self, pid: i32, title: &str, mut controls: Vec<Facts>) {
        for (i, x) in controls.iter_mut().enumerate() {
            if i > 0 {
                x.path = vec![i - 1];
                x.frame = [100, 100 + 30 * i as i64, 80, 24];
            } else {
                x.frame = [100, 80, 600, 400];
            }
        }
        let mut windows = self.windows.lock().unwrap();
        let list = windows.entry(pid).or_default();
        list.push(title.into());
        self.nodes.lock().unwrap().insert((pid, list.len() - 1), controls);
    }

    /// Window `w` of app `pid` is now called `title` (a document renamed, a browser gone to another page).
    pub fn set_title(&self, pid: i32, w: usize, title: &str) {
        self.windows.lock().unwrap().get_mut(&pid).unwrap()[w] = title.into();
        self.change(pid, w, 0, |x| x.label = title.into());
    }

    pub fn add_app(&self, app: App) {
        self.apps.lock().unwrap().push(app);
    }

    pub fn quit(&self, pid: i32) {
        self.apps.lock().unwrap().retain(|a| a.pid != pid);
    }

    fn note(&self, c: String) {
        self.calls.lock().unwrap().push(c);
    }

    fn node(&self, pid: i32, window: usize, i: usize) -> Option<Node> {
        let nodes = self.nodes.lock().unwrap();
        let x = nodes.get(&(pid, window))?.get(i)?.clone();
        Some(Node { depth: usize::from(i > 0), role: x.role.into(), subrole: x.subrole.into(), label: x.label, value: x.value, enabled: x.enabled, handle: Arc::new((pid, window, i)) as Handle })
    }

    fn at(handle: &Handle) -> (i32, usize, usize) {
        *handle.downcast_ref::<(i32, usize, usize)>().unwrap()
    }
}

impl Desk for Stand {
    fn accessibility(&self) -> bool {
        self.ax
    }
    fn screen(&self) -> bool {
        self.screen
    }
    fn locked(&self) -> bool {
        self.locked.load(Ordering::SeqCst)
    }
    fn own_pid(&self) -> i32 {
        OWN
    }
    fn apps(&self) -> Vec<App> {
        self.apps.lock().unwrap().clone()
    }
    fn windows(&self, pid: i32) -> Result<Vec<String>, String> {
        self.note(format!("windows {pid}"));
        Ok(self.windows.lock().unwrap().get(&pid).cloned().unwrap_or_default())
    }
    fn tree(&self, pid: i32, window: usize) -> Result<Vec<Node>, String> {
        self.note(format!("tree {pid} {window}"));
        let n = self.nodes.lock().unwrap().get(&(pid, window)).map_or(0, Vec::len);
        Ok((0..n).filter_map(|i| self.node(pid, window, i)).collect())
    }
    fn picture(&self, pid: i32, window: usize) -> Result<Vec<u8>, String> {
        self.note(format!("picture {pid} {window}"));
        Ok(b"\x89PNG stand-in".to_vec())
    }
    fn again(&self, handle: &Handle) -> Option<Node> {
        let (pid, w, i) = Stand::at(handle);
        self.node(pid, w, i)
    }
    fn place(&self, handle: &Handle) -> Option<Place> {
        let (pid, w, i) = Stand::at(handle);
        let nodes = self.nodes.lock().unwrap();
        let x = nodes.get(&(pid, w))?.get(i)?;
        Some(Place { window: Some(window_number(pid, w)), path: x.path.clone(), frame: Some(x.frame) })
    }
    fn snapshot(&self, place: &Place) -> Result<Vec<u8>, String> {
        self.note(format!("snapshot {} {:?}", place.window.unwrap_or(0), place.frame.unwrap_or_default()));
        Ok(b"\x89PNG control".to_vec())
    }
    fn focus(&self, pid: i32) -> Option<Focus> {
        let w = self.focused.lock().unwrap().get(&pid).copied().unwrap_or(Some(0))?;
        let title = self.windows.lock().unwrap().get(&pid)?.get(w).cloned()?;
        let i = self.focused_control.lock().unwrap().get(&(pid, w)).copied();
        let control = match i {
            Some(i) => {
                let n = self.node(pid, w, i)?;
                let p = self.place(&n.handle)?;
                Some((n, p))
            }
            None => None,
        };
        Some(Focus { window: Win { number: Some(window_number(pid, w)), title }, control })
    }
    fn press(&self, handle: &Handle) -> Result<(), String> {
        let (pid, w, i) = Stand::at(handle);
        self.note(format!("press {pid} {w} {i}"));
        Ok(())
    }
    fn set_value(&self, handle: &Handle, text: &str) -> Result<(), String> {
        let (pid, w, i) = Stand::at(handle);
        self.note(format!("set {pid} {w} {i} {text}"));
        self.change(pid, w, i, |x| x.value = Some(text.into()));
        Ok(())
    }
    fn key(&self, pid: i32, chord: &Chord) -> Result<(), String> {
        self.note(format!("key {pid} {}", chord.shown()));
        Ok(())
    }
    fn menu(&self, pid: i32, path: &[String]) -> Result<(), String> {
        self.note(format!("menu {pid} {}", path.join(" › ")));
        Ok(())
    }
}
