//! What the Mac keeps for reaching it from a phone (docs/remote-access.md, item 78b): one more generic password item in
//! the login keychain, beside the API session (service `xyz.manut.desktop.api`, account `remote`), holding a small JSON
//! document. It has the Mac's relay key (a P-256 key whose public half hashes to the host id the relay names the Mac
//! by, kept as its JWK's `d`, `x` and `y`), and for each paired phone its name, when it paired and was last seen, K (the
//! secret every session of that phone is proved with, as 64 lowercase hex digits), the hash of its relay door token, and
//! its passkey (credential id, public key and signature counter). Never in a file and never in a log.
//!
//! The page (src/remote/keys.ts) reads it with `remote_keys_read` and imports the relay key and each K at once as keys
//! script cannot read back, as it does the shop cache's key (shop_cache_key.rs); it changes it only through the four
//! narrow commands below, so it never has to hold a secret in order to write the document back. Every field's form is
//! checked here before anything is written, a second relay key is refused (so two windows can never replace the key the
//! relay knows the Mac by), a phone whose passkey already belongs to another is refused (the remote channel's caller duty,
//! packages/remote-channel/README.md), and a passkey's counter never goes down. Nothing here makes a key: the page makes
//! the relay key and K, and only once the person has turned "Reach this Mac from your phone" on. macOS only for now:
//! elsewhere the commands answer `unavailable`, and the page keeps nothing.

use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

/// The keychain item's account, beside `session` (api_link.rs), `outpost` and `shop-cache-key`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const ACCOUNT: &str = "remote";

/// The most phones one Mac keeps: the relay holds eight devices a Mac, and one place stays for the pairing door.
pub const MAX_PHONES: usize = 7;
const MAX_NAME_CHARS: usize = 64;
/// A credential id is at most 1023 bytes (WebAuthn Level 3, section 6.5.1): 1364 base64url characters.
const MAX_CREDENTIAL_CHARS: usize = 1364;

/// The Mac's relay key, as its JWK's fields. Wiped when dropped.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
pub struct HostKey {
    pub d: String,
    pub x: String,
    pub y: String,
}

impl Drop for HostKey {
    fn drop(&mut self) {
        self.d.zeroize();
    }
}

/// One paired phone. `k` is wiped when dropped; nothing else in it is secret.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub paired_at: u64,
    pub last_seen: Option<u64>,
    pub k: String,
    pub token_hash: String,
    pub credential_id: String,
    pub public_key: String,
    pub sign_count: u32,
}

impl Drop for Device {
    fn drop(&mut self) {
        self.k.zeroize();
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
pub struct Doc {
    pub v: u32,
    pub host: Option<HostKey>,
    pub devices: Vec<Device>,
}

impl Default for Doc {
    fn default() -> Self {
        Doc { v: 1, host: None, devices: Vec::new() }
    }
}

fn is_b64url(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A device id as the relay takes it: upper case, 8-4-4-4-12.
fn is_device_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_digit() || (b'A'..=b'F').contains(b),
        })
}

/// A phone's name as the page cleans it: no control or line-separator characters, no space at either end and none
/// doubled, at most 64 characters, and not empty.
fn is_name(value: &str) -> bool {
    let count = value.chars().count();
    count > 0
        && count <= MAX_NAME_CHARS
        && !value.chars().any(|c| c.is_control() || c == '\u{2028}' || c == '\u{2029}')
        && value.trim() == value
        && !value.contains("  ")
        && !value.chars().any(|c| c.is_whitespace() && c != ' ')
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn valid_host(host: &HostKey) -> bool {
    is_b64url(&host.d, 43, 43) && is_b64url(&host.x, 43, 43) && is_b64url(&host.y, 43, 43)
}

pub fn valid_device(device: &Device) -> bool {
    is_device_id(&device.id)
        && is_name(&device.name)
        && device.last_seen.is_none_or(|seen| seen <= u64::MAX / 2)
        && is_hex64(&device.k)
        && is_b64url(&device.token_hash, 43, 43)
        && is_b64url(&device.credential_id, 1, MAX_CREDENTIAL_CHARS)
        && is_b64url(&device.public_key, 87, 87)
}

/// The whole document, checked: version 1, a valid key if any, at most seven valid phones, no id or passkey twice.
pub fn valid_doc(doc: &Doc) -> bool {
    doc.v == 1
        && doc.host.as_ref().is_none_or(valid_host)
        && doc.devices.len() <= MAX_PHONES
        && doc.devices.iter().all(valid_device)
        && doc.devices.iter().enumerate().all(|(i, d)| {
            doc.devices[..i].iter().all(|e| e.id != d.id && e.credential_id != d.credential_id)
        })
}

/// The document an item holds, or `None` for an item that is missing or that this build cannot read: a damaged item
/// is never half read, and the next key the page keeps replaces it.
pub fn parse(text: &str) -> Option<Doc> {
    serde_json::from_str::<Doc>(text).ok().filter(valid_doc)
}

/// The document as the item keeps it, in a buffer wiped when dropped.
pub fn write_text(doc: &Doc) -> Result<Zeroizing<String>, &'static str> {
    if !valid_doc(doc) {
        return Err("invalid");
    }
    serde_json::to_string(doc).map(Zeroizing::new).map_err(|_| "invalid")
}

/// Adds the relay key. Refused when one is held.
pub fn with_host(mut doc: Doc, host: HostKey) -> Result<Doc, &'static str> {
    if !valid_host(&host) {
        return Err("invalid");
    }
    if doc.host.is_some() {
        return Err("exists");
    }
    doc.host = Some(host);
    Ok(doc)
}

/// Adds a phone. Refused for a malformed record, an id already held, a passkey that belongs to another phone, and past
/// the most phones.
pub fn with_device(mut doc: Doc, device: Device) -> Result<Doc, &'static str> {
    if !valid_device(&device) {
        return Err("invalid");
    }
    if doc.devices.iter().any(|d| d.id == device.id) {
        return Err("exists");
    }
    if doc.devices.iter().any(|d| d.credential_id == device.credential_id) {
        return Err("credential_taken");
    }
    if doc.devices.len() >= MAX_PHONES {
        return Err("full");
    }
    doc.devices.push(device);
    Ok(doc)
}

/// Notes that a phone was seen, and its passkey's counter, which may not go down.
pub fn with_touch(mut doc: Doc, id: &str, last_seen: u64, sign_count: u32) -> Result<Doc, &'static str> {
    let device = doc.devices.iter_mut().find(|d| d.id == id).ok_or("not_found")?;
    if sign_count < device.sign_count {
        return Err("counter");
    }
    device.last_seen = Some(last_seen);
    device.sign_count = sign_count;
    Ok(doc)
}

/// Forgets a phone, K and passkey with it. Forgetting one that is not there is not an error.
pub fn without_device(mut doc: Doc, id: &str) -> Doc {
    doc.devices.retain(|d| d.id != id);
    doc
}

/// What the item holds now, as text for the page, or `None`.
pub fn read() -> Result<Option<Zeroizing<String>>, String> {
    #[cfg(target_os = "macos")]
    return mac::read(&crate::api_link::mac::default_keychain()?).map_err(String::from);
    #[cfg(not(target_os = "macos"))]
    return Err("unavailable".into());
}

/// Runs one change on the held document and writes it back.
pub fn change(edit: impl FnOnce(Doc) -> Result<Doc, &'static str>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return mac::change(&crate::api_link::mac::default_keychain()?, edit).map_err(String::from);
    #[cfg(not(target_os = "macos"))]
    return {
        let _ = edit;
        Err("unavailable".into())
    };
}

#[cfg(target_os = "macos")]
pub mod mac {
    use super::{parse, write_text, Doc, ACCOUNT};
    use crate::api_link::mac::{read_item, write_item};
    use security_framework::os::macos::keychain::SecKeychain;
    use std::sync::Mutex;
    use zeroize::Zeroizing;

    /// Reading the document and writing it back are one step under this lock, so two changes at once never lose one.
    static LOCK: Mutex<()> = Mutex::new(());

    pub fn read(keychain: &SecKeychain) -> Result<Option<Zeroizing<String>>, &'static str> {
        let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some(held) = read_item(keychain, ACCOUNT)? else { return Ok(None) };
        match parse(&held) {
            Some(doc) => write_text(&doc).map(Some),
            None => Ok(None),
        }
    }

    pub fn change(keychain: &SecKeychain, edit: impl FnOnce(Doc) -> Result<Doc, &'static str>) -> Result<(), &'static str> {
        let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let doc = read_item(keychain, ACCOUNT)?.and_then(|held| parse(&held)).unwrap_or_default();
        let next = edit(doc)?;
        write_item(keychain, ACCOUNT, &write_text(&next)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const D: &str = "ND3D5rH1njNLwBqTX5kqQnpFLNKx73U6tRrpFvS5o1g";
    const X: &str = "ib4IYB2I05R5eSGPoGQYYa5fikBQPHuN_FW2mvDAWps";
    const Y: &str = "WwwTFjoML5S42ZLKXTw3B9rhDJgQakFJ53yDPYXnlnE";

    fn host() -> HostKey {
        HostKey { d: D.into(), x: X.into(), y: Y.into() }
    }

    fn host_with(change: impl FnOnce(&mut HostKey)) -> HostKey {
        let mut h = host();
        change(&mut h);
        h
    }

    fn device_with(n: u8, change: impl FnOnce(&mut Device)) -> Device {
        let mut d = device(n);
        change(&mut d);
        d
    }

    fn device(n: u8) -> Device {
        Device {
            id: format!("00000000-0000-4000-8000-0000000000{n:02X}"),
            name: format!("Phone {n}"),
            paired_at: 1_800_000_000_000,
            last_seen: None,
            k: format!("{:02x}", n).repeat(32),
            token_hash: "okZozeX-5QrWGv0EoFHBLlAgh6-UCySRqSr_W8iAhqw".into(),
            credential_id: format!("credential-{n}"),
            public_key: "B".repeat(87),
            sign_count: 0,
        }
    }

    #[test]
    fn takes_only_well_formed_keys_and_phones() {
        assert!(valid_host(&host()));
        for bad in [host_with(|h| h.d = "short".into()), host_with(|h| h.x = format!("{X}=")), host_with(|h| h.y = "+".repeat(43))] {
            assert!(!valid_host(&bad), "{bad:?}");
        }
        assert!(valid_device(&device(1)));
        let cases: Vec<(&str, Device)> = vec![
            ("lower-case id", device_with(1, |d| { d.id = "00000000-0000-4000-8000-00000000000a".into(); })),
            ("id without dashes", device_with(1, |d| { d.id = "0".repeat(36); })),
            ("empty name", device_with(1, |d| { d.name = String::new(); })),
            ("name with a line break", device_with(1, |d| { d.name = "a\nb".into(); })),
            ("name with a tab", device_with(1, |d| { d.name = "a\tb".into(); })),
            ("name with a line separator", device_with(1, |d| { d.name = "a\u{2028}b".into(); })),
            ("name with a space at its end", device_with(1, |d| { d.name = "Phone ".into(); })),
            ("name with two spaces", device_with(1, |d| { d.name = "a  b".into(); })),
            ("name too long", device_with(1, |d| { d.name = "a".repeat(65); })),
            ("upper-case K", device_with(1, |d| { d.k = "A".repeat(64); })),
            ("short K", device_with(1, |d| { d.k = "a".repeat(63); })),
            ("token hash with padding", device_with(1, |d| { d.token_hash = format!("{}=", "a".repeat(42)); })),
            ("empty credential id", device_with(1, |d| { d.credential_id = String::new(); })),
            ("credential id too long", device_with(1, |d| { d.credential_id = "a".repeat(1365); })),
            ("public key of another length", device_with(1, |d| { d.public_key = "B".repeat(86); })),
        ];
        for (why, bad) in cases {
            assert!(!valid_device(&bad), "{why}");
        }
        // Names in other scripts are kept as they are.
        assert!(valid_device(&device_with(1, |d| { d.name = "สมชาย の iPhone".into(); })));
    }

    #[test]
    fn keeps_one_relay_key_and_refuses_a_second() {
        let doc = with_host(Doc::default(), host()).unwrap();
        assert_eq!(doc.host, Some(host()));
        let other = host_with(|h| h.d = "a".repeat(43));
        assert_eq!(with_host(doc.clone(), other), Err("exists"));
        assert_eq!(with_host(Doc::default(), host_with(|h| h.d = "x".into())), Err("invalid"));
    }

    #[test]
    fn adds_phones_up_to_seven_and_refuses_a_repeated_id_or_passkey() {
        let mut doc = Doc::default();
        for n in 0..7 {
            doc = with_device(doc, device(n)).unwrap();
        }
        assert_eq!(with_device(doc.clone(), device(9)), Err("full"));
        let doc = without_device(doc, &device(6).id);
        assert_eq!(with_device(doc.clone(), device(0)), Err("exists"));
        let same_passkey = device_with(9, |d| { d.id = device(9).id.clone(); d.credential_id = device(0).credential_id.clone(); });
        assert_eq!(with_device(doc.clone(), same_passkey), Err("credential_taken"));
        assert_eq!(with_device(doc.clone(), device_with(9, |d| { d.name = "\u{7}".into(); })), Err("invalid"));
        assert_eq!(with_device(doc, device(9)).map(|d| d.devices.len()), Ok(7));
    }

    #[test]
    fn notes_when_a_phone_was_seen_and_never_takes_a_counter_back() {
        let doc = with_device(Doc::default(), device_with(1, |d| { d.sign_count = 5; })).unwrap();
        let id = device(1).id.clone();
        let seen = with_touch(doc.clone(), &id, 1_800_000_001_000, 6).unwrap();
        assert_eq!((seen.devices[0].last_seen, seen.devices[0].sign_count), (Some(1_800_000_001_000), 6));
        // The same counter is taken (a synced passkey sends 0 every time); a lower one is not.
        assert!(with_touch(seen.clone(), &id, 1_800_000_002_000, 6).is_ok());
        assert_eq!(with_touch(seen.clone(), &id, 1_800_000_002_000, 4), Err("counter"));
        assert_eq!(with_touch(seen, &device(2).id, 1, 1), Err("not_found"));
    }

    #[test]
    fn reads_a_document_only_whole_and_well_formed() {
        let doc = with_device(with_host(Doc::default(), host()).unwrap(), device(1)).unwrap();
        let text = write_text(&doc).unwrap();
        assert_eq!(parse(&text), Some(doc.clone()));
        assert!(text.contains("\"pairedAt\"") && text.contains("\"tokenHash\"") && text.contains("\"signCount\""), "{}", text.as_str());
        for bad in [
            String::new(),
            "not json".into(),
            text.replace("\"v\":1", "\"v\":2"),
            text.replace("\"devices\":[", "\"extra\":1,\"devices\":["),
            text.replace(&device(1).k, "zz"),
        ] {
            assert_eq!(parse(&bad), None, "{bad}");
        }
        // Two phones with one passkey is a document no build writes, and none reads.
        let twice = Doc { devices: vec![device(1), device_with(1, |d| { d.id = device(2).id.clone(); })], ..Doc::default() };
        assert!(write_text(&twice).is_err());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn has_no_keychain_outside_macos_yet() {
        assert_eq!(read().map(|d| d.is_some()), Err("unavailable".to_string()));
        assert_eq!(change(Ok), Err("unavailable".to_string()));
    }

    #[cfg(target_os = "macos")]
    mod keychain {
        use super::super::{mac, parse, with_device, with_host, with_touch, without_device, ACCOUNT};
        use super::{device, device_with, host, host_with};
        use crate::api_link::mac as session;
        use crate::api_link::mac::{read_item, write_item};
        use crate::api_link::scratch_keychain::scratch;

        const SESSION: &str = r#"{"v":1,"accessToken":"a-1"}"#;

        #[test]
        fn reads_nothing_until_a_key_is_kept_and_keeps_its_own_item_beside_the_others() {
            let s = scratch("remote-keys");
            session::write(&s.keychain, SESSION).unwrap();
            write_item(&s.keychain, "shop-cache-key", &"a".repeat(64)).unwrap();
            // Nothing is made by a read.
            assert!(mac::read(&s.keychain).unwrap().is_none());
            assert!(read_item(&s.keychain, ACCOUNT).unwrap().is_none());
            mac::change(&s.keychain, |doc| with_host(doc, host())).unwrap();
            mac::change(&s.keychain, |doc| with_device(doc, device(1))).unwrap();
            let text = mac::read(&s.keychain).unwrap().expect("kept");
            let doc = parse(&text).unwrap();
            assert_eq!(doc.host, Some(host()));
            assert_eq!(doc.devices, vec![device(1)]);
            // The items beside it are untouched.
            assert_eq!(session::read(&s.keychain).unwrap().as_deref(), Some(SESSION));
            assert_eq!(read_item(&s.keychain, "shop-cache-key").unwrap().as_deref().map(String::as_str), Some("a".repeat(64).as_str()));
        }

        #[test]
        fn refuses_a_second_key_and_a_repeated_passkey_and_writes_nothing_then() {
            let s = scratch("remote-keys-refuse");
            mac::change(&s.keychain, |doc| with_host(doc, host())).unwrap();
            mac::change(&s.keychain, |doc| with_device(doc, device(1))).unwrap();
            let before = read_item(&s.keychain, ACCOUNT).unwrap().unwrap();
            let other = host_with(|h| h.d = "a".repeat(43));
            assert_eq!(mac::change(&s.keychain, |doc| with_host(doc, other)), Err("exists"));
            let twin = device_with(1, |d| { d.id = device(2).id.clone(); });
            assert_eq!(mac::change(&s.keychain, |doc| with_device(doc, twin)), Err("credential_taken"));
            assert_eq!(read_item(&s.keychain, ACCOUNT).unwrap().unwrap().as_str(), before.as_str());
        }

        #[test]
        fn notes_a_phone_seen_and_forgets_it_with_its_k() {
            let s = scratch("remote-keys-forget");
            mac::change(&s.keychain, |doc| with_device(doc, device(1))).unwrap();
            mac::change(&s.keychain, |doc| with_touch(doc, &device(1).id, 7, 3)).unwrap();
            let doc = parse(&mac::read(&s.keychain).unwrap().unwrap()).unwrap();
            assert_eq!((doc.devices[0].last_seen, doc.devices[0].sign_count), (Some(7), 3));
            assert_eq!(mac::change(&s.keychain, |doc| with_touch(doc, &device(1).id, 8, 2)), Err("counter"));
            mac::change(&s.keychain, |doc| Ok(without_device(doc, &device(1).id))).unwrap();
            let text = mac::read(&s.keychain).unwrap().unwrap();
            assert!(parse(&text).unwrap().devices.is_empty());
            assert!(!text.contains(&device(1).k), "K is gone from the item");
        }

        #[test]
        fn treats_a_damaged_item_as_none_and_replaces_it_on_the_next_change() {
            let s = scratch("remote-keys-damaged");
            write_item(&s.keychain, ACCOUNT, "{\"v\":1,\"host\":null,\"devices\":[{\"id\":\"x\"}]}").unwrap();
            assert!(mac::read(&s.keychain).unwrap().is_none());
            mac::change(&s.keychain, |doc| with_host(doc, host())).unwrap();
            assert_eq!(parse(&mac::read(&s.keychain).unwrap().unwrap()).unwrap().host, Some(host()));
        }

        #[test]
        fn changes_at_the_same_time_lose_none() {
            let s = scratch("remote-keys-race");
            let keychain = &s.keychain;
            std::thread::scope(|scope| {
                for n in 0..6u8 {
                    scope.spawn(move || mac::change(keychain, |doc| with_device(doc, device(n))).unwrap());
                }
            });
            let doc = parse(&mac::read(keychain).unwrap().unwrap()).unwrap();
            assert_eq!(doc.devices.len(), 6);
        }
    }
}
