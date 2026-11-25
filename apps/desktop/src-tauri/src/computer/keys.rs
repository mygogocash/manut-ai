//! A key press the agent asks for, read as one chord ("Return", "Cmd+S", "Shift+Tab"), and the shortcuts computer use
//! never sends.
//!
//! The chord's spelling and the list of refused shortcuts are lifted from Orca (`stablyai/orca`, MIT,
//! `src/main/computer/action-contracts/computer-blocked-key-combos.ts`, macOS rules), which ported them from
//! vercel-labs/agent-desktop (Apache-2.0): the same modifier names, the same two key aliases, and the same five
//! shortcuts, which quit the app, log out, lock the screen, open Force Quit or empty the Trash. Orca lets a caller
//! send one anyway with `--allow-system-shortcut`; Manut AI has no such way round.
//!
//! The key codes are the Mac's virtual key codes as Apple's `HIToolbox/Events.h` names them (`kVK_ANSI_A` = 0x00 and
//! so on), and only the keys below are sent: letters, digits, the usual punctuation, Return, Tab, Space, the two
//! deletes, Escape, the arrows, Home, End, Page Up and Page Down.

/// One key with the modifiers held for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chord {
    pub cmd: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    /// The key's own name, as [`KEYS`] spells it.
    pub key: &'static str,
    /// Its virtual key code.
    pub code: u16,
}

/// The longest chord text read. A longer one is refused rather than read in part.
const CHORD_CHARS: usize = 40;

/// Every key that may be sent, by name, with its virtual key code from `HIToolbox/Events.h`.
pub const KEYS: [(&str, u16); 61] = [
    ("a", 0x00), ("s", 0x01), ("d", 0x02), ("f", 0x03), ("h", 0x04), ("g", 0x05), ("z", 0x06), ("x", 0x07),
    ("c", 0x08), ("v", 0x09), ("b", 0x0B), ("q", 0x0C), ("w", 0x0D), ("e", 0x0E), ("r", 0x0F), ("y", 0x10),
    ("t", 0x11), ("1", 0x12), ("2", 0x13), ("3", 0x14), ("4", 0x15), ("6", 0x16), ("5", 0x17), ("=", 0x18),
    ("9", 0x19), ("7", 0x1A), ("-", 0x1B), ("8", 0x1C), ("0", 0x1D), ("]", 0x1E), ("o", 0x1F), ("u", 0x20),
    ("[", 0x21), ("i", 0x22), ("p", 0x23), ("l", 0x25), ("j", 0x26), ("'", 0x27), ("k", 0x28), (";", 0x29),
    ("\\", 0x2A), (",", 0x2B), ("/", 0x2C), ("n", 0x2D), ("m", 0x2E), (".", 0x2F), ("`", 0x32),
    ("return", 0x24), ("tab", 0x30), ("space", 0x31), ("backspace", 0x33), ("escape", 0x35),
    ("home", 0x73), ("pageup", 0x74), ("forwarddelete", 0x75), ("end", 0x77), ("pagedown", 0x79),
    ("left", 0x7B), ("right", 0x7C), ("down", 0x7D), ("up", 0x7E),
];

/// The other names a key is often written with, as Orca reads them (`esc`, and `delete` for the key labelled delete,
/// which is the one that deletes backwards), and a few more spellings people use.
const KEY_ALIASES: [(&str, &str); 10] = [
    ("esc", "escape"),
    ("delete", "backspace"),
    ("enter", "return"),
    ("arrowleft", "left"),
    ("arrowright", "right"),
    ("arrowdown", "down"),
    ("arrowup", "up"),
    ("page up", "pageup"),
    ("page down", "pagedown"),
    ("forward delete", "forwarddelete"),
];

/// The shortcuts never sent, most specific first so the refusal names what the shortcut would do (Orca's macOS list).
/// Extra modifiers still match: Cmd+Option+Shift+Q logs out just as Cmd+Shift+Q does.
const BLOCKED: [(&[&str], &str, &str); 5] = [
    (&["cmd", "ctrl"], "q", "lock the screen"),
    (&["cmd", "shift"], "q", "log out of macOS"),
    (&["cmd", "alt"], "escape", "open the Force Quit window"),
    (&["cmd", "shift"], "backspace", "empty the Trash"),
    (&["cmd"], "q", "quit the app"),
];

/// The modifier a word names, as Orca's aliases read it, or None.
fn modifier(word: &str) -> Option<&'static str> {
    let w: String = word.chars().filter(|c| !matches!(c, ' ' | '_' | '-')).collect();
    match w.as_str() {
        "cmd" | "command" | "meta" | "super" | "win" | "cmdorctrl" | "commandorcontrol" => Some("cmd"),
        "ctrl" | "control" => Some("ctrl"),
        "alt" | "option" | "opt" => Some("alt"),
        "shift" => Some("shift"),
        _ => None,
    }
}

/// The key a word names, with its code, or None.
fn key_of(word: &str) -> Option<(&'static str, u16)> {
    let w = KEY_ALIASES.iter().find(|(a, _)| *a == word).map(|(_, k)| *k).unwrap_or(word);
    KEYS.iter().find(|(k, _)| *k == w).copied()
}

/// `text` as one chord: modifiers and exactly one key, joined by `+`, in any case. Anything else is refused with a
/// sentence the agent can act on.
pub fn parse(text: &str) -> Result<Chord, String> {
    let t = text.trim();
    if t.is_empty() || t.chars().count() > CHORD_CHARS || t.chars().any(char::is_control) {
        return Err("Name one key, for example \"Return\" or \"Cmd+S\".".into());
    }
    let mut c = Chord { cmd: false, ctrl: false, alt: false, shift: false, key: "", code: 0 };
    let mut key: Option<(&'static str, u16)> = None;
    // "+" is the separator, so a key of its own that is "+" or "=" with Shift is written "Shift+="
    for part in t.split('+') {
        let word = part.trim().to_lowercase();
        if word.is_empty() {
            return Err(format!("\"{t}\" is not one key with its modifiers, such as \"Cmd+S\"."));
        }
        match modifier(&word) {
            Some("cmd") => c.cmd = true,
            Some("ctrl") => c.ctrl = true,
            Some("alt") => c.alt = true,
            Some(_) => c.shift = true,
            None => {
                if key.is_some() {
                    return Err(format!("\"{t}\" names more than one key: press one key at a time."));
                }
                key = Some(key_of(&word).ok_or_else(|| format!("\"{}\" is not a key computer use sends.", part.trim()))?);
            }
        }
    }
    let (k, code) = key.ok_or_else(|| format!("\"{t}\" names no key, only modifiers."))?;
    c.key = k;
    c.code = code;
    Ok(c)
}

impl Chord {
    fn has(&self, m: &str) -> bool {
        match m {
            "cmd" => self.cmd,
            "ctrl" => self.ctrl,
            "alt" => self.alt,
            _ => self.shift,
        }
    }

    /// What the shortcut would do when it is one computer use never sends, else None.
    pub fn blocked(&self) -> Option<&'static str> {
        BLOCKED.iter().find(|(mods, k, _)| *k == self.key && mods.iter().all(|m| self.has(m))).map(|(_, _, effect)| *effect)
    }

    /// The chord as the card shows it: "Cmd+Shift+S", "Return".
    pub fn shown(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        for (on, name) in [(self.ctrl, "Control"), (self.alt, "Option"), (self.shift, "Shift"), (self.cmd, "Cmd")] {
            if on {
                parts.push(name.into());
            }
        }
        let key = match self.key {
            "return" => "Return".to_string(),
            "tab" => "Tab".into(),
            "space" => "Space".into(),
            "backspace" => "Delete".into(),
            "forwarddelete" => "Forward Delete".into(),
            "escape" => "Escape".into(),
            "home" => "Home".into(),
            "end" => "End".into(),
            "pageup" => "Page Up".into(),
            "pagedown" => "Page Down".into(),
            "left" => "Left Arrow".into(),
            "right" => "Right Arrow".into(),
            "up" => "Up Arrow".into(),
            "down" => "Down Arrow".into(),
            k => k.to_uppercase(),
        };
        parts.push(key);
        parts.join("+")
    }

    /// The modifier flags for `CGEventSetFlags`: `kCGEventFlagMaskShift` and the others are IOKit's `NX_SHIFTMASK`
    /// (0x00020000), `NX_CONTROLMASK` (0x00040000), `NX_ALTERNATEMASK` (0x00080000) and `NX_COMMANDMASK` (0x00100000).
    pub fn flags(&self) -> u64 {
        let mut f = 0;
        if self.shift {
            f |= 0x0002_0000;
        }
        if self.ctrl {
            f |= 0x0004_0000;
        }
        if self.alt {
            f |= 0x0008_0000;
        }
        if self.cmd {
            f |= 0x0010_0000;
        }
        f
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_one_key_with_its_modifiers_in_any_spelling() {
        let c = parse("Cmd+S").unwrap();
        assert!(c.cmd && !c.shift && !c.alt && !c.ctrl);
        assert_eq!((c.key, c.code), ("s", 0x01));
        assert_eq!(parse("command + shift + s").unwrap(), Chord { shift: true, ..c.clone() });
        assert_eq!(parse("CmdOrCtrl+S").unwrap(), c);
        assert_eq!(parse("Return").unwrap().code, 0x24);
        assert_eq!(parse("enter").unwrap().key, "return");
        assert_eq!(parse("esc").unwrap().code, 0x35);
        assert_eq!(parse("Option+Left").unwrap(), Chord { cmd: false, ctrl: false, alt: true, shift: false, key: "left", code: 0x7B });
        assert_eq!(parse("Down").unwrap().code, 0x7D);
        assert_eq!(parse("Shift+Tab").unwrap().flags(), 0x0002_0000);
        assert_eq!(parse("Ctrl+Option+Shift+Cmd+K").unwrap().flags(), 0x001E_0000);
        assert_eq!(parse("Cmd+Shift+S").unwrap().shown(), "Shift+Cmd+S");
        assert_eq!(parse("delete").unwrap().shown(), "Delete");
    }

    #[test]
    fn refuses_what_is_not_one_known_key() {
        for bad in ["", "  ", "Cmd+", "+", "Cmd", "Cmd+Shift", "S+D", "F13", "Cmd+S\nReturn", "Hyper+S", &"a+".repeat(30)] {
            assert!(parse(bad).is_err(), "{bad:?}");
        }
    }

    /// Orca's five macOS shortcuts, with extra modifiers too, are never sent; the same keys without them are.
    #[test]
    fn never_sends_a_shortcut_that_quits_logs_out_locks_force_quits_or_empties_the_trash() {
        assert_eq!(parse("Cmd+Q").unwrap().blocked(), Some("quit the app"));
        assert_eq!(parse("Cmd+Ctrl+Q").unwrap().blocked(), Some("lock the screen"));
        assert_eq!(parse("Cmd+Shift+Q").unwrap().blocked(), Some("log out of macOS"));
        assert_eq!(parse("Cmd+Alt+Shift+Q").unwrap().blocked(), Some("log out of macOS"));
        assert_eq!(parse("Cmd+Option+Esc").unwrap().blocked(), Some("open the Force Quit window"));
        assert_eq!(parse("Cmd+Shift+Delete").unwrap().blocked(), Some("empty the Trash"));
        assert_eq!(parse("command+q").unwrap().blocked(), Some("quit the app"));
        for fine in ["Q", "Shift+Q", "Cmd+W", "Cmd+S", "Escape", "Cmd+Delete", "Option+Escape"] {
            assert_eq!(parse(fine).unwrap().blocked(), None, "{fine}");
        }
    }

    #[test]
    fn every_key_has_its_own_code() {
        let mut codes: Vec<u16> = KEYS.iter().map(|(_, c)| *c).collect();
        let n = codes.len();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), n);
    }
}
