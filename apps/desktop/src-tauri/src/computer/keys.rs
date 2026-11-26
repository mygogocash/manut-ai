//! A key press the agent asks for, read as one chord ("Return", "Cmd+S", "Shift+Tab"), the shortcuts computer use
//! never sends, and which key sends a chord on the keyboard layout in use.
//!
//! The chord's spelling and the list of refused shortcuts are lifted from Orca (`stablyai/orca`, MIT,
//! `src/main/computer/action-contracts/computer-blocked-key-combos.ts`, macOS rules), which ported them from
//! vercel-labs/agent-desktop (Apache-2.0): the same modifier names, the same two key aliases, and the same five
//! shortcuts, which quit the app, log out, lock the screen, open Force Quit or empty the Trash. Orca lets a caller
//! send one anyway with `--allow-system-shortcut`; Manut AI has no such way round.
//!
//! A key is sent as a virtual key code, which names a key's place on the keyboard, not what it types (`HIToolbox/
//! Events.h`: "Other keyboard layouts may have the 'A' key label on a different physical key"). So the keys whose place
//! is the same on every layout (Return, Tab, Space, the two deletes, Escape, the arrows, Home, End, Page Up and Page
//! Down, Events.h's "keycodes for keys that are independent of keyboard layout") keep their codes, and a letter, digit
//! or punctuation mark is sent by the key that types it on the layout in use ([`Chord::code`]): on a French Mac the key
//! in the US "A" place types Q, so a card that says Cmd+A sent by that place would quit the app. The blocked shortcuts
//! are checked against what that key types on every layout the person has turned on, alone and with Command held, so
//! no reading of what is sent is a shortcut that is never sent.

/// One key with the modifiers held for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chord {
    pub cmd: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    /// The key's own name: one of [`NAMED`], or the character a key types, one of [`CHARS`].
    pub key: &'static str,
}

/// The longest chord text read. A longer one is refused rather than read in part.
const CHORD_CHARS: usize = 40;

/// The keys whose place is the same on every keyboard layout, by name, with their virtual key codes from
/// `HIToolbox/Events.h` (`kVK_Return` = 0x24 and so on).
pub const NAMED: [(&str, u16); 14] = [
    ("return", 0x24), ("tab", 0x30), ("space", 0x31), ("backspace", 0x33), ("escape", 0x35),
    ("home", 0x73), ("pageup", 0x74), ("forwarddelete", 0x75), ("end", 0x77), ("pagedown", 0x79),
    ("left", 0x7B), ("right", 0x7C), ("down", 0x7D), ("up", 0x7E),
];

/// The characters a key press may name: letters, digits and the usual punctuation. Which key types each depends on the
/// layout.
pub const CHARS: [&str; 47] = [
    "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w",
    "x", "y", "z", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "=", "-", "]", "[", "'", ";", "\\", ",", "/", ".",
    "`",
];

/// The virtual key codes of the keys that type a character, whose place a layout decides: `kVK_ANSI_A` (0x00) to
/// `kVK_ANSI_Grave` (0x32), `kVK_ISO_Section` (0x0A) among them, without Return, Tab and Space. The keypad is left out:
/// apps read its keys apart.
pub fn char_codes() -> impl Iterator<Item = u16> {
    (0x00..=0x32).filter(|c| ![0x24, 0x30, 0x31].contains(c))
}

/// A keyboard layout as the Mac reads it (`UCKeyTranslate` over its `uchr` data): for each key in [`char_codes`], the
/// character it types alone and the one it types with Command held, or None when it types none. Some layouts type
/// other characters with Command: Thai and Russian type QWERTY letters, "Dvorak - QWERTY Command" types QWERTY.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Layout {
    /// Its name as macOS shows it ("U.S.", "French"), for a refusal's words.
    pub name: String,
    pub keys: Vec<(u16, Option<char>, Option<char>)>,
}

/// The layouts a key press is read against: the one in use first, then the others the person has turned on, since an
/// app can type with another of them (macOS can keep a layout per document).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Keyboard {
    pub current: Layout,
    pub others: Vec<Layout>,
}

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

/// The key a word names, as its name in [`NAMED`] or [`CHARS`], or None.
fn key_of(word: &str) -> Option<&'static str> {
    let w = KEY_ALIASES.iter().find(|(a, _)| *a == word).map(|(_, k)| *k).unwrap_or(word);
    NAMED.iter().map(|(k, _)| *k).chain(CHARS).find(|k| *k == w)
}

/// The name in [`CHARS`] of a character a key types, in lower case, or None for one a key press never names.
fn char_key(c: char) -> Option<&'static str> {
    let c = c.to_lowercase().next().unwrap_or(c);
    CHARS.iter().copied().find(|k| k.chars().next() == Some(c))
}

/// `text` as one chord: modifiers and exactly one key, joined by `+`, in any case. Anything else is refused with a
/// sentence the agent can act on.
pub fn parse(text: &str) -> Result<Chord, String> {
    let t = text.trim();
    if t.is_empty() || t.chars().count() > CHORD_CHARS || t.chars().any(char::is_control) {
        return Err("Name one key, for example \"Return\" or \"Cmd+S\".".into());
    }
    let mut c = Chord { cmd: false, ctrl: false, alt: false, shift: false, key: "" };
    let mut key: Option<&'static str> = None;
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
    c.key = key.ok_or_else(|| format!("\"{t}\" names no key, only modifiers."))?;
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

    /// The virtual key code that sends this chord on `kb`: a key whose place is the same everywhere by its own code,
    /// and a character by the key that types it on the layout in use (with Command held, the character a key types
    /// then, which is what a shortcut is read by). An error in plain words when no key types it there, or when the key
    /// found types, on any layout turned on, alone or with Command, a character that with these modifiers is a shortcut
    /// that is never sent.
    pub fn code(&self, kb: &Keyboard) -> Result<u16, String> {
        if let Some((_, code)) = NAMED.iter().find(|(k, _)| *k == self.key) {
            return Ok(*code);
        }
        let want = self.key.chars().next().unwrap_or_default();
        let typed = |k: &(u16, Option<char>, Option<char>)| if self.cmd { k.2 } else { k.1 };
        let with = if self.cmd { " with Command held" } else { "" };
        let code = kb
            .current
            .keys
            .iter()
            .find(|k| typed(k).and_then(char_key) == Some(self.key))
            .map(|k| k.0)
            .ok_or_else(|| format!("On this Mac's keyboard layout ({}), no key types “{}”{with}, so computer use cannot press {}. Reach the goal another way, such as the window's own button or menu item.", kb.current.name, want.to_uppercase(), self.shown()))?;
        for layout in std::iter::once(&kb.current).chain(&kb.others) {
            let Some(&(_, alone, command)) = layout.keys.iter().find(|k| k.0 == code) else { continue };
            for read in [alone, command].into_iter().flatten().filter_map(char_key) {
                let as_read = Chord { key: read, ..self.clone() };
                if let Some(effect) = as_read.blocked() {
                    return Err(format!(
                        "On the {} keyboard layout the key that types “{}” here types “{}”, and {} would {effect}, so computer use never sends it. Reach the goal another way, such as the window's own button or menu item.",
                        layout.name,
                        want.to_uppercase(),
                        read.to_uppercase(),
                        as_read.shown()
                    ));
                }
            }
        }
        Ok(code)
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
    use crate::computer::stand::{layout, DVORAK, DVORAK_QWERTY_CMD, FRENCH, THAI, US};

    fn kb(current: &Layout, others: &[&Layout]) -> Keyboard {
        Keyboard { current: current.clone(), others: others.iter().map(|l| (*l).clone()).collect() }
    }

    #[test]
    fn reads_one_key_with_its_modifiers_in_any_spelling() {
        let us = kb(&layout("U.S.", &US), &[]);
        let c = parse("Cmd+S").unwrap();
        assert!(c.cmd && !c.shift && !c.alt && !c.ctrl);
        assert_eq!((c.key, c.code(&us)), ("s", Ok(0x01)));
        assert_eq!(parse("command + shift + s").unwrap(), Chord { shift: true, ..c.clone() });
        assert_eq!(parse("CmdOrCtrl+S").unwrap(), c);
        assert_eq!(parse("Return").unwrap().code(&us), Ok(0x24));
        assert_eq!(parse("enter").unwrap().key, "return");
        assert_eq!(parse("esc").unwrap().code(&us), Ok(0x35));
        assert_eq!(parse("Option+Left").unwrap(), Chord { cmd: false, ctrl: false, alt: true, shift: false, key: "left" });
        assert_eq!(parse("Down").unwrap().code(&us), Ok(0x7D));
        assert_eq!(parse("Shift+Tab").unwrap().flags(), 0x0002_0000);
        assert_eq!(parse("Ctrl+Option+Shift+Cmd+K").unwrap().flags(), 0x001E_0000);
        assert_eq!(parse("Cmd+Shift+S").unwrap().shown(), "Shift+Cmd+S");
        assert_eq!(parse("delete").unwrap().shown(), "Delete");
    }

    #[test]
    fn refuses_what_is_not_one_known_key() {
        for bad in ["", "  ", "Cmd+", "+", "Cmd", "Cmd+Shift", "S+D", "F13", "Cmd+S\nReturn", "Hyper+S", &"a+".repeat(30), "é", "Cmd+@"] {
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

    /// On a French (AZERTY) Mac the key in the US "A" place types Q, and on Dvorak the key in the US "X" place types Q:
    /// a card that says Cmd+A or Cmd+X sends the key that types A or X there, never the one that types Q. Thai and
    /// Russian type QWERTY letters with Command held, which is what their shortcuts are read by.
    #[test]
    fn a_chord_is_sent_by_the_character_the_layout_types() {
        let (us, french, dvorak, thai) = (layout("U.S.", &US), layout("French", &FRENCH), layout("Dvorak", &DVORAK), layout("Thai", &THAI));
        let code = |text: &str, l: &Layout| parse(text).unwrap().code(&kb(l, &[]));
        assert_eq!(code("Cmd+A", &french), Ok(0x0C));
        assert_eq!(code("Cmd+Z", &french), Ok(0x0D));
        assert_eq!(code("Cmd+M", &french), Ok(0x29));
        assert_eq!(code("Cmd+X", &dvorak), Ok(0x0B));
        assert_eq!(code("Cmd+S", &dvorak), Ok(0x29));
        assert_eq!(code("Cmd+S", &thai), Ok(0x01));
        assert_eq!(code("Cmd+Shift+Z", &thai), Ok(0x06));
        // on a US Mac every key is where Events.h's ANSI names put it
        for (ch, ansi) in [("a", 0x00), ("s", 0x01), ("q", 0x0C), ("1", 0x12), ("=", 0x18), ("/", 0x2C), ("`", 0x32), ("\\", 0x2A), ("'", 0x27)] {
            assert_eq!(parse(&format!("Shift+{ch}")).unwrap().code(&kb(&us, &[])), Ok(ansi), "{ch}");
        }
        // the keys whose place is the same everywhere keep their codes
        assert_eq!(code("Cmd+Option+Escape", &french), Ok(0x35));
        assert_eq!(code("Return", &thai), Ok(0x24));
        // a character no key types on the layout: refused in plain words
        assert!(code("Cmd+1", &french).unwrap_err().contains("no key types “1” with Command held"));
        assert!(code("S", &thai).unwrap_err().contains("(Thai), no key types “S”"));
    }

    /// Every chord on every layout, with every other layout turned on beside it: what is sent types the character the
    /// card names on the layout in use, and no reading of that key, on any layout turned on, alone or with Command, is
    /// a shortcut that is never sent. "Dvorak - QWERTY Command" types Q alone where it types X with Command, and ABC
    /// types Q where French types A: those chords are refused rather than sent.
    #[test]
    fn no_layout_turns_a_chord_into_a_blocked_shortcut() {
        let all = [layout("U.S.", &US), layout("French", &FRENCH), layout("Dvorak", &DVORAK), layout("Dvorak - QWERTY Cmd", &DVORAK_QWERTY_CMD), layout("Thai", &THAI)];
        let mut sent = 0;
        for current in &all {
            for other in std::iter::once(None).chain(all.iter().map(Some)) {
                let keyboard = kb(current, other.as_slice());
                for ch in CHARS {
                    for m in 0..16u8 {
                        let chord = Chord { cmd: m & 1 != 0, ctrl: m & 2 != 0, alt: m & 4 != 0, shift: m & 8 != 0, key: ch };
                        let Ok(code) = chord.code(&keyboard) else { continue };
                        sent += 1;
                        let typed = current.keys.iter().find(|k| k.0 == code).and_then(|k| if chord.cmd { k.2 } else { k.1 }).and_then(char_key);
                        assert_eq!(typed, Some(ch), "{} on {}", chord.shown(), current.name);
                        for l in std::iter::once(current).chain(other) {
                            let k = l.keys.iter().find(|k| k.0 == code).unwrap();
                            for read in [k.1, k.2].into_iter().flatten().filter_map(char_key) {
                                assert_eq!(Chord { key: read, ..chord.clone() }.blocked(), None, "{} on {} sends a key {} reads as {read}", chord.shown(), current.name, l.name);
                            }
                        }
                    }
                }
            }
        }
        assert!(sent > 10_000, "{sent}");
        let dq = layout("Dvorak - QWERTY Cmd", &DVORAK_QWERTY_CMD);
        assert!(parse("Cmd+X").unwrap().code(&kb(&dq, &[])).unwrap_err().contains("types “Q”"));
        let (us, french) = (layout("U.S.", &US), layout("French", &FRENCH));
        assert!(parse("Cmd+A").unwrap().code(&kb(&french, &[&us])).unwrap_err().contains("On the U.S. keyboard layout"));
        assert_eq!(parse("Cmd+W").unwrap().code(&kb(&french, &[&us])), Ok(0x06));
    }

    #[test]
    fn every_named_key_and_character_is_its_own() {
        let mut codes: Vec<u16> = NAMED.iter().map(|(_, c)| *c).collect();
        let n = codes.len();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), n);
        assert!(char_codes().all(|c| !codes.contains(&c)));
        let mut chars = CHARS.to_vec();
        chars.sort_unstable();
        chars.dedup();
        assert_eq!(chars.len(), CHARS.len());
    }
}
