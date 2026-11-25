//! A stand-in Mac for the tests: a few apps with windows and controls, and a record of everything asked of it. Nothing
//! here touches the real screen.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use super::keys::Chord;
use super::room::{App, Desk, Handle, Node, Place};

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

fn f(role: &'static str, label: &str) -> Facts {
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

pub struct Stand {
    ax: bool,
    screen: bool,
    locked: AtomicBool,
    apps: Mutex<Vec<App>>,
    windows: HashMap<i32, Vec<String>>,
    nodes: Mutex<HashMap<(i32, usize), Vec<Facts>>>,
    focused: Mutex<HashMap<i32, String>>,
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
        nodes.insert((TEXTEDIT, 0), vec![f("AXWindow", "Untitled"), f("AXButton", "Save"), area, secure, cancel, f("AXTextField", "Name")]);
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
            windows,
            nodes: Mutex::new(nodes),
            focused: Mutex::new(HashMap::new()),
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

    pub fn focus(&self, pid: i32, title: &str) {
        self.focused.lock().unwrap().insert(pid, title.into());
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
        Ok(self.windows.get(&pid).cloned().unwrap_or_default())
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
    fn focused_window(&self, pid: i32) -> Option<String> {
        self.focused.lock().unwrap().get(&pid).cloned().or_else(|| self.windows.get(&pid)?.first().cloned())
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
