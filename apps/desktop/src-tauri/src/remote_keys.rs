//! What the Mac keeps for reaching it from a phone (docs/remote-access.md, item 78b): one more generic password item in
//! the login keychain, beside the API session (service `xyz.manut.desktop.api`, account `remote`), holding a small JSON
//! document. It has the Mac's relay key (a P-256 key whose public half hashes to the host id the relay names the Mac
//! by, kept as its JWK's `d`, `x` and `y`), and for each paired phone its name, when it paired and was last seen, K (the
//! secret every session of that phone is proved with, as 64 lowercase hex digits), the hash of its relay door token, and
//! its passkey (credential id, public key and signature counter). Never in a file and never in a log.
//!
//! The page (src/remote/keys.ts) reads it with `remote_keys_read` and changes it only through narrow commands, so it
//! never has to hold a secret in order to write the document back. Every field's form is checked here before anything is
//! written, a second relay key is refused (so two windows can never replace the key the relay knows the Mac by), a phone
//! whose passkey already belongs to another is refused (the remote channel's caller duty,
//! packages/remote-channel/README.md), and a passkey's counter never goes down.
//!
//! A script injected into the main window can call every command the page can (third review, 26 Nov 2026), so the shell
//! hands out as little as the page needs, and only while it needs it:
//! - The relay key's private half never leaves the shell. The shell makes the key (`make_host`, with the system's own
//!   generator) and signs the relay's challenge itself (`sign_host`), and signs nothing but that challenge for this key's
//!   host id. The page is given the public half.
//! - Each phone's K is in the page's read only while the shell's own switch is on (`Gate`), which the page turns on after
//!   the person's consent and off with the switch; the page imports it at once as a key script cannot read back.
//! - A phone is added only while the shell has a pairing open (at most five minutes, opened only while the switch is on),
//!   one phone a pairing, and a counter only moves while the switch is on. Unpair is never held back.
//! The shell cannot tell the page from a script in it, so a script that turns the switch on and opens a pairing first
//! still gets K and can still add a phone; what it can no longer do is read the relay key, or read K or add a phone with
//! one plain call while the switch is off. macOS only for now: elsewhere the commands answer `unavailable`, and the page
//! keeps nothing.
//!
//! Each phone's record also says what it may do from afar (item 108b, src/remote/levels.ts): a level, Watch, Answer or
//! Work, and Terminal and Manage, which only Work may hold. A record kept before that item has none and reads as Answer,
//! exactly what a phone could do then, and Answer is written as no level at all, so a build from before the item still
//! reads every record whose phone was never narrowed. A level this build does not know is refused with the whole
//! document, as any field it cannot read is: never read as Answer or anything wider. The page checks the level for every
//! request; the shell only keeps it.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};
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

/// What a phone may do from afar (item 108b): each level has everything of the one before. Answer is the default, for a
/// record kept before the level existed and for every new pairing.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Watch,
    #[default]
    Answer,
    Work,
}

impl Level {
    fn is_answer(&self) -> bool {
        *self == Level::Answer
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// One paired phone. `k` is wiped when dropped; nothing else in it is secret. `level`, `terminal` and `manage` are left
/// out when they are the default (Answer, neither permission), so a record of a phone never narrowed reads in a build
/// from before them.
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
    #[serde(default, skip_serializing_if = "Level::is_answer")]
    pub level: Level,
    #[serde(default, skip_serializing_if = "is_false")]
    pub terminal: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub manage: bool,
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

/// Terminal and Manage only beside Work.
fn valid_grant(level: Level, terminal: bool, manage: bool) -> bool {
    level == Level::Work || (!terminal && !manage)
}

pub fn valid_device(device: &Device) -> bool {
    valid_grant(device.level, device.terminal, device.manage)
        && is_device_id(&device.id)
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

/// The relay key as the page is given it: its public half, never `d`.
#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct HostPublic {
    pub x: String,
    pub y: String,
}

/// One phone as the page is given it: K only while the switch is on.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageDevice<'a> {
    id: &'a str,
    name: &'a str,
    paired_at: u64,
    last_seen: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    k: Option<&'a str>,
    token_hash: &'a str,
    credential_id: &'a str,
    public_key: &'a str,
    sign_count: u32,
    level: Level,
    terminal: bool,
    manage: bool,
}

#[derive(Serialize)]
struct PageDoc<'a> {
    v: u32,
    host: Option<HostPublic>,
    devices: Vec<PageDevice<'a>>,
}

/// What the page is given of the document: never the relay key's private half, and each phone's K only `with_k` (the
/// switch on). In a buffer wiped when dropped.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn page_text(doc: &Doc, with_k: bool) -> Result<Zeroizing<String>, &'static str> {
    let page = PageDoc {
        v: doc.v,
        host: doc.host.as_ref().map(|h| HostPublic { x: h.x.clone(), y: h.y.clone() }),
        devices: doc
            .devices
            .iter()
            .map(|d| PageDevice {
                id: &d.id,
                name: &d.name,
                paired_at: d.paired_at,
                last_seen: d.last_seen,
                k: if with_k { Some(&d.k) } else { None },
                token_hash: &d.token_hash,
                credential_id: &d.credential_id,
                public_key: &d.public_key,
                sign_count: d.sign_count,
                level: d.level,
                terminal: d.terminal,
                manage: d.manage,
            })
            .collect(),
    };
    serde_json::to_string(&page).map(Zeroizing::new).map_err(|_| "invalid")
}

const B64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// base64url without padding (RFC 4648 section 5), as the item, the page and the relay write keys and signatures.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn b64url(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..=chunk.len() {
            out.push(B64URL[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

/// The bytes of base64url text without padding, in a buffer wiped when dropped; `None` for anything else, a text whose
/// last character carries bits it should not included.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn from_b64url(text: &str) -> Option<Zeroizing<Vec<u8>>> {
    if text.len() % 4 == 1 {
        return None;
    }
    let mut out = Zeroizing::new(Vec::with_capacity(text.len() * 3 / 4));
    let (mut acc, mut bits) = (0u32, 0u32);
    for b in text.bytes() {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    if acc != 0 {
        return None;
    }
    Some(out)
}

/// The host id the relay names the Mac by: the base64url SHA-256 of the relay key's uncompressed public point.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn host_id(x: &str, y: &str) -> Option<String> {
    let (x, y) = (from_b64url(x)?, from_b64url(y)?);
    if x.len() != 32 || y.len() != 32 {
        return None;
    }
    let mut hash = Sha256::new();
    hash.update([0x04]);
    hash.update(&*x);
    hash.update(&*y);
    Some(b64url(&hash.finalize()))
}

/// The one message the relay key signs: the relay's challenge for this Mac (`challengeMessage` in src/remote/link.ts,
/// `verifyHostHello` in apps/api/src/relay.ts), its host id and the relay's 32-byte nonce, and nothing else.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn is_relay_challenge(message: &str, host_id: &str) -> bool {
    let parts: Vec<&str> = message.split('|').collect();
    parts.len() == 4 && parts[0] == "gospark-relay-v1" && parts[1] == "host" && parts[2] == host_id && is_b64url(parts[3], 43, 43)
}

/// An ECDSA signature as DER (`SEQUENCE { INTEGER r, INTEGER s }`, RFC 3279), as Security's X9.62 algorithms give it,
/// as the raw `r || s` the relay verifies (Web Crypto's form); `None` for anything that is not exactly that.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn der_to_raw(der: &[u8]) -> Option<[u8; 64]> {
    let (&tag, rest) = der.split_first()?;
    let (&len, mut body) = rest.split_first()?;
    if tag != 0x30 || len >= 0x80 || usize::from(len) != body.len() {
        return None;
    }
    let mut out = [0u8; 64];
    for half in 0..2 {
        let (&t, rest) = body.split_first()?;
        let (&l, rest) = rest.split_first()?;
        let l = usize::from(l);
        if t != 0x02 || l == 0 || l > 33 || rest.len() < l {
            return None;
        }
        let (int, rest) = rest.split_at(l);
        let int = if l == 33 {
            if int[0] != 0 {
                return None;
            }
            &int[1..]
        } else {
            int
        };
        out[half * 32 + 32 - int.len()..half * 32 + 32].copy_from_slice(int);
        body = rest;
    }
    body.is_empty().then_some(out)
}

/// How long a pairing may add its phone: the code's two minutes, then two for the phone's passkey, and one to spare.
pub const PAIRING_WINDOW: Duration = Duration::from_secs(5 * 60);

/// The shell's own record of "Reach this Mac from your phone" and of a pairing under way. The page sets both, after the
/// person's consent and while a code is shown; the shell cannot tell the page from a script in it, but nothing secret is
/// read, and no phone added, without them.
#[derive(Debug)]
pub struct Gate {
    on: bool,
    pairing_until: Option<Instant>,
}

impl Gate {
    pub const fn new() -> Self {
        Gate { on: false, pairing_until: None }
    }

    /// Off closes any pairing too.
    pub fn set_switch(&mut self, on: bool) {
        self.on = on;
        if !on {
            self.pairing_until = None;
        }
    }

    pub fn is_on(&self) -> bool {
        self.on
    }

    pub fn require_on(&self) -> Result<(), &'static str> {
        if self.on { Ok(()) } else { Err("off") }
    }

    /// Opens a pairing for `PAIRING_WINDOW` (only while on), or closes it.
    pub fn set_pairing(&mut self, open: bool, now: Instant) -> Result<(), &'static str> {
        if !open {
            self.pairing_until = None;
            return Ok(());
        }
        self.require_on()?;
        self.pairing_until = Some(now + PAIRING_WINDOW);
        Ok(())
    }

    /// Spends the open pairing for one phone: refused with none open, one past its time, or the switch off.
    pub fn take_pairing(&mut self, now: Instant) -> Result<(), &'static str> {
        let until = self.pairing_until.take();
        match until {
            Some(until) if self.on && now < until => Ok(()),
            _ => Err("no_pairing"),
        }
    }
}

impl Default for Gate {
    fn default() -> Self {
        Gate::new()
    }
}

static GATE: Mutex<Gate> = Mutex::new(Gate::new());

/// The app's one gate.
pub fn gate() -> MutexGuard<'static, Gate> {
    GATE.lock().unwrap_or_else(|e| e.into_inner())
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

/// Sets what a phone may do from afar. Refused for a phone not kept, and for Terminal or Manage without Work.
pub fn with_level(mut doc: Doc, id: &str, level: Level, terminal: bool, manage: bool) -> Result<Doc, &'static str> {
    if !valid_grant(level, terminal, manage) {
        return Err("invalid");
    }
    let device = doc.devices.iter_mut().find(|d| d.id == id).ok_or("not_found")?;
    device.level = level;
    device.terminal = terminal;
    device.manage = manage;
    Ok(doc)
}

/// Forgets a phone, K and passkey with it. Forgetting one that is not there is not an error.
pub fn without_device(mut doc: Doc, id: &str) -> Doc {
    doc.devices.retain(|d| d.id != id);
    doc
}

/// What the item holds now, as the page is given it (`page_text`: no `d`, K only while the switch is on), or `None`.
pub fn read() -> Result<Option<Zeroizing<String>>, String> {
    let with_k = gate().is_on();
    #[cfg(target_os = "macos")]
    return mac::read(&crate::api_link::mac::default_keychain()?, with_k).map_err(String::from);
    #[cfg(not(target_os = "macos"))]
    return {
        let _ = with_k;
        Err("unavailable".into())
    };
}

/// Makes the relay key in the shell and keeps it, once, only while the switch is on. Refused (`exists`) when one is kept.
pub fn make_host() -> Result<(), String> {
    gate().require_on()?;
    #[cfg(target_os = "macos")]
    return {
        let host = relay_key::make()?;
        change(|doc| with_host(doc, host))
    };
    #[cfg(not(target_os = "macos"))]
    return Err("unavailable".into());
}

/// The relay's challenge signed with the relay key, as base64url of the raw signature; only while the switch is on, and
/// only that challenge (`is_relay_challenge`).
pub fn sign_host(message: &str) -> Result<String, String> {
    gate().require_on()?;
    #[cfg(target_os = "macos")]
    return mac::sign_relay(&crate::api_link::mac::default_keychain()?, message).map_err(String::from);
    #[cfg(not(target_os = "macos"))]
    return {
        let _ = message;
        Err("unavailable".into())
    };
}

/// Keeps a newly paired phone, spending the open pairing first.
pub fn add_device(device: Device) -> Result<(), String> {
    gate().take_pairing(Instant::now())?;
    change(|doc| with_device(doc, device))
}

/// Notes a phone seen and its counter, only while the switch is on.
pub fn touch_device(id: &str, last_seen: u64, sign_count: u32) -> Result<(), String> {
    gate().require_on()?;
    change(|doc| with_touch(doc, id, last_seen, sign_count))
}

/// Sets what a phone may do from afar, switch on or off, as Unpair is: a level is only what the person at this Mac gave,
/// and narrowing one must never wait on the switch.
pub fn set_level(id: &str, level: Level, terminal: bool, manage: bool) -> Result<(), String> {
    change(|doc| with_level(doc, id, level, terminal, manage))
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

/// The relay key's operations, done in the shell so its private half never reaches the page: making it with the system's
/// own generator, and signing with it. Through Security's `SecKey`, on keys that are never put in any keychain.
#[cfg(target_os = "macos")]
pub mod relay_key {
    use super::{b64url, der_to_raw, from_b64url, HostKey};
    use core_foundation::base::TCFType;
    use core_foundation::data::CFData;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::error::CFError;
    use core_foundation::string::CFString;
    use security_framework::key::{Algorithm, GenerateKeyOptions, KeyType, SecKey};
    use security_framework_sys::item::{kSecAttrKeyClass, kSecAttrKeyClassPrivate, kSecAttrKeyClassPublic, kSecAttrKeyType, kSecAttrKeyTypeECSECPrimeRandom};
    use security_framework_sys::key::SecKeyCreateWithData;
    use zeroize::Zeroizing;

    /// A new P-256 key, as the JWK fields the item keeps.
    pub fn make() -> Result<HostKey, &'static str> {
        let mut options = GenerateKeyOptions::default();
        options.set_key_type(KeyType::ec_sec_prime_random()).set_size_in_bits(256);
        let key = SecKey::new(&options).map_err(|_| "keychain")?;
        let data = key.external_representation().ok_or("keychain")?;
        // ANSI X9.63: 04 || X || Y || D.
        let bytes = Zeroizing::new(data.bytes().to_vec());
        if bytes.len() != 97 || bytes[0] != 0x04 {
            return Err("keychain");
        }
        Ok(HostKey { d: b64url(&bytes[65..97]), x: b64url(&bytes[1..33]), y: b64url(&bytes[33..65]) })
    }

    /// A key from its X9.63 bytes (`04 || X || Y`, and `|| D` for the private half).
    fn import(bytes: &[u8], private: bool) -> Result<SecKey, &'static str> {
        let class = if private { unsafe { kSecAttrKeyClassPrivate } } else { unsafe { kSecAttrKeyClassPublic } };
        let attributes = unsafe {
            CFDictionary::from_CFType_pairs(&[
                (CFString::wrap_under_get_rule(kSecAttrKeyType), CFString::wrap_under_get_rule(kSecAttrKeyTypeECSECPrimeRandom)),
                (CFString::wrap_under_get_rule(kSecAttrKeyClass), CFString::wrap_under_get_rule(class)),
            ])
        };
        let data = CFData::from_buffer(bytes);
        let mut error = std::ptr::null_mut();
        let key = unsafe { SecKeyCreateWithData(data.as_concrete_TypeRef(), attributes.as_concrete_TypeRef(), &mut error) };
        if key.is_null() {
            if !error.is_null() {
                drop(unsafe { CFError::wrap_under_create_rule(error) });
            }
            return Err("invalid");
        }
        Ok(unsafe { SecKey::wrap_under_create_rule(key) })
    }

    /// `message` signed with `host`, as the raw `r || s` the relay verifies.
    pub fn sign(host: &HostKey, message: &[u8]) -> Result<[u8; 64], &'static str> {
        let mut bytes = Zeroizing::new(Vec::with_capacity(97));
        bytes.push(0x04);
        for part in [&host.x, &host.y, &host.d] {
            let part = from_b64url(part).filter(|b| b.len() == 32).ok_or("invalid")?;
            bytes.extend_from_slice(&part);
        }
        let key = import(&bytes, true)?;
        let der = key.create_signature(Algorithm::ECDSASignatureMessageX962SHA256, message).map_err(|_| "keychain")?;
        der_to_raw(&der).ok_or("keychain")
    }

    /// Whether `raw` is `x`, `y`'s signature over `message`, for tests.
    #[cfg(test)]
    pub fn verify(x: &str, y: &str, message: &[u8], raw: &[u8; 64]) -> bool {
        let mut point = vec![0x04];
        point.extend_from_slice(&from_b64url(x).unwrap());
        point.extend_from_slice(&from_b64url(y).unwrap());
        let Ok(key) = import(&point, false) else { return false };
        let integer = |bytes: &[u8]| {
            let mut b: Vec<u8> = bytes.iter().copied().skip_while(|&v| v == 0).collect();
            if b.first().is_none_or(|&v| v & 0x80 != 0) {
                b.insert(0, 0);
            }
            let mut out = vec![0x02, b.len() as u8];
            out.extend(b);
            out
        };
        let mut body = integer(&raw[..32]);
        body.extend(integer(&raw[32..]));
        let mut der = vec![0x30, body.len() as u8];
        der.extend(body);
        key.verify_signature(Algorithm::ECDSASignatureMessageX962SHA256, message, &der).unwrap_or(false)
    }
}

#[cfg(target_os = "macos")]
pub mod mac {
    use super::{b64url, host_id, is_relay_challenge, page_text, parse, relay_key, write_text, Doc, ACCOUNT};
    use crate::api_link::mac::{read_item, write_item};
    use security_framework::os::macos::keychain::SecKeychain;
    use std::sync::Mutex;
    use zeroize::Zeroizing;

    /// Reading the document and writing it back are one step under this lock, so two changes at once never lose one.
    static LOCK: Mutex<()> = Mutex::new(());

    /// The item as the page is given it: no `d`, and K only `with_k`.
    pub fn read(keychain: &SecKeychain, with_k: bool) -> Result<Option<Zeroizing<String>>, &'static str> {
        let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some(held) = read_item(keychain, ACCOUNT)? else { return Ok(None) };
        match parse(&held) {
            Some(doc) => page_text(&doc, with_k).map(Some),
            None => Ok(None),
        }
    }

    /// The relay's challenge signed with the kept relay key; refused for any other message.
    pub fn sign_relay(keychain: &SecKeychain, message: &str) -> Result<String, &'static str> {
        let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let doc = read_item(keychain, ACCOUNT)?.and_then(|held| parse(&held)).ok_or("no_key")?;
        let host = doc.host.as_ref().ok_or("no_key")?;
        let id = host_id(&host.x, &host.y).ok_or("invalid")?;
        if !is_relay_challenge(message, &id) {
            return Err("not_a_challenge");
        }
        relay_key::sign(host, message.as_bytes()).map(|raw| b64url(&raw))
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
            level: Level::Answer,
            terminal: false,
            manage: false,
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

    /// A record kept before item 108b, as that build wrote it: no level, terminal or manage.
    const OLD_RECORD: &str = r#"{"v":1,"host":null,"devices":[{"id":"00000000-0000-4000-8000-000000000001","name":"Phone 1","pairedAt":1800000000000,"lastSeen":null,"k":"0101010101010101010101010101010101010101010101010101010101010101","tokenHash":"okZozeX-5QrWGv0EoFHBLlAgh6-UCySRqSr_W8iAhqw","credentialId":"credential-1","publicKey":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","signCount":0}]}"#;

    #[test]
    fn reads_a_record_kept_before_levels_as_answer_and_writes_answer_as_it_was() {
        let doc = parse(OLD_RECORD).expect("an old record is read");
        assert_eq!((doc.devices[0].level, doc.devices[0].terminal, doc.devices[0].manage), (Level::Answer, false, false));
        assert_eq!(doc.devices[0], device(1));
        // Written back unchanged, so a build from before levels still reads it.
        assert_eq!(write_text(&doc).unwrap().as_str(), OLD_RECORD);
        // A new pairing is Answer, and is kept with no level either.
        let text = write_text(&with_device(Doc::default(), device(2)).unwrap()).unwrap();
        assert!(!text.contains("level") && !text.contains("terminal") && !text.contains("manage"), "{}", text.as_str());
    }

    #[test]
    fn keeps_a_level_and_reads_it_back() {
        let id = device(1).id.clone();
        let doc = with_device(Doc::default(), device(1)).unwrap();
        let watch = with_level(doc.clone(), &id, Level::Watch, false, false).unwrap();
        let text = write_text(&watch).unwrap();
        assert!(text.contains(r#""level":"watch""#) && !text.contains("terminal"), "{}", text.as_str());
        assert_eq!(parse(&text).unwrap().devices[0].level, Level::Watch);
        let all = with_level(doc.clone(), &id, Level::Work, true, true).unwrap();
        let back = parse(&write_text(&all).unwrap()).unwrap();
        assert_eq!((back.devices[0].level, back.devices[0].terminal, back.devices[0].manage), (Level::Work, true, true));
        // Back to Answer is no level at all again.
        let answer = with_level(watch, &id, Level::Answer, false, false).unwrap();
        assert_eq!(answer, doc);
        // The page's read always says the level, so the page never guesses it.
        let page = page_text(&doc, false).unwrap();
        assert!(page.contains(r#""level":"answer","terminal":false,"manage":false"#), "{}", page.as_str());
        assert!(page_text(&all, false).unwrap().contains(r#""level":"work","terminal":true,"manage":true"#));
        // Refused for a phone not kept, and for a permission without Work.
        assert_eq!(with_level(doc.clone(), &device(2).id, Level::Watch, false, false), Err("not_found"));
        assert_eq!(with_level(doc.clone(), &id, Level::Answer, true, false), Err("invalid"));
        assert_eq!(with_level(doc, &id, Level::Watch, false, true), Err("invalid"));
    }

    #[test]
    fn refuses_a_level_it_does_not_know_rather_than_widening_it() {
        let watch = OLD_RECORD.replace(r#""signCount":0"#, r#""signCount":0,"level":"watch""#);
        assert_eq!(parse(&watch).unwrap().devices[0].level, Level::Watch);
        for bad in [
            r#""level":"admin""#,
            r#""level":"Answer""#,
            r#""level":"owner""#,
            r#""level":null"#,
            r#""level":2"#,
            r#""terminal":true"#,
            r#""level":"answer","manage":true"#,
            r#""level":"work","terminal":"yes""#,
            r#""grant":"work""#,
        ] {
            let text = OLD_RECORD.replace(r#""signCount":0"#, &format!(r#""signCount":0,{bad}"#));
            assert_eq!(parse(&text), None, "{bad}");
        }
        // The page's command takes only a level this build knows: anything else does not deserialize.
        assert_eq!(serde_json::from_str::<Level>(r#""work""#).ok(), Some(Level::Work));
        for bad in [r#""admin""#, r#""WATCH""#, "null", "1", r#""""#] {
            assert!(serde_json::from_str::<Level>(bad).is_err(), "{bad}");
        }
        // Nor does a document hold Terminal or Manage without Work.
        let wrong = Doc { devices: vec![device_with(1, |d| { d.terminal = true; })], ..Doc::default() };
        assert!(write_text(&wrong).is_err());
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

    /// The relay vectors' host id and challenge (apps/api/test/fixtures/relay-v1-vectors.json), whose key is `host()`.
    const HOST_ID: &str = "GnOvYLqZ2OHWO6ttlRtTcGTPJe7LvdxH1_QGvKsS3b8";
    const NONCE: &str = "x-zdxt1ft5j89tFMjyzj8E5P3egK4zsukMoSWAXYFWs";
    const SIGNATURE: &str = "pzraaa8GE5yaccH-AkRN1OUQlkn3HPZgTkYoQa7k_EiXSaxVC6K5dQiSsmRVDOZQD7QIFNLpMIluj6gGoMBOuw";

    #[test]
    fn names_the_host_and_reads_base64url_as_the_relay_does() {
        assert_eq!(host_id(X, Y).as_deref(), Some(HOST_ID));
        assert_eq!(host_id("short", Y), None);
        for bytes in [&b""[..], &b"f"[..], &b"fo"[..], &b"foo"[..], &b"foob"[..], &[0xff, 0xfe, 0xfd, 0xfc][..]] {
            assert_eq!(from_b64url(&b64url(bytes)).as_deref().map(Vec::as_slice), Some(bytes));
        }
        assert_eq!(b64url(&[0xfb, 0xff]), "-_8");
        for bad in ["a", "ab=", "a+b", "a/b", "AB", "-_9"] {
            assert!(from_b64url(bad).is_none(), "{bad}");
        }
        let message = format!("gospark-relay-v1|host|{HOST_ID}|{NONCE}");
        assert!(is_relay_challenge(&message, HOST_ID));
        assert!(!is_relay_challenge(&message, &"A".repeat(43)));
    }

    #[test]
    fn reads_a_der_signature_as_the_raw_one_the_relay_verifies() {
        // r with its high bit set (a zero first in DER), s short (zeros first in raw).
        let mut der = vec![0x30, 0x43, 0x02, 0x21, 0x00];
        der.extend([0x80; 32]);
        der.extend([0x02, 0x1e]);
        der.extend([0x11; 30]);
        let raw = der_to_raw(&der).unwrap();
        assert_eq!(&raw[..32], &[0x80; 32]);
        assert_eq!(&raw[32..34], &[0, 0]);
        assert_eq!(&raw[34..], &[0x11; 30]);
        for bad in [vec![], vec![0x31, 0x00], vec![0x30, 0x02, 0x02, 0x00], der[..der.len() - 1].to_vec(), [&der[..], &[0]].concat()] {
            assert!(der_to_raw(&bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn hands_the_page_no_private_key_and_k_only_while_on() {
        let doc = with_device(with_host(Doc::default(), host()).unwrap(), device(1)).unwrap();
        let on = page_text(&doc, true).unwrap();
        let off = page_text(&doc, false).unwrap();
        for text in [on.as_str(), off.as_str()] {
            assert!(!text.contains(D) && !text.contains("\"d\""), "{text}");
            assert!(text.contains(X) && text.contains(Y) && text.contains("\"pairedAt\""), "{text}");
        }
        assert!(on.contains(&device(1).k));
        assert!(!off.contains(&device(1).k) && !off.contains("\"k\""));
    }

    #[test]
    fn adds_a_phone_only_through_one_open_pairing_while_on() {
        let t0 = Instant::now();
        let mut gate = Gate::new();
        assert_eq!(gate.take_pairing(t0), Err("no_pairing"));
        assert_eq!(gate.set_pairing(true, t0), Err("off"));
        assert_eq!(gate.require_on(), Err("off"));
        gate.set_switch(true);
        assert_eq!(gate.take_pairing(t0), Err("no_pairing"));
        gate.set_pairing(true, t0).unwrap();
        assert_eq!(gate.take_pairing(t0), Ok(()));
        // One phone a pairing.
        assert_eq!(gate.take_pairing(t0), Err("no_pairing"));
        // Not past its five minutes.
        gate.set_pairing(true, t0).unwrap();
        assert_eq!(gate.take_pairing(t0 + PAIRING_WINDOW), Err("no_pairing"));
        // Closed, or the switch turned off, it adds nothing, and off is off until turned on again.
        gate.set_pairing(true, t0).unwrap();
        gate.set_pairing(false, t0).unwrap();
        assert_eq!(gate.take_pairing(t0), Err("no_pairing"));
        gate.set_pairing(true, t0).unwrap();
        gate.set_switch(false);
        gate.set_switch(true);
        assert_eq!(gate.take_pairing(t0), Err("no_pairing"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn makes_and_signs_with_a_p256_key_the_relay_verifies() {
        // The relay vectors' own signature, made by Web Crypto, checks out against their key: the raw form is read right.
        let raw: [u8; 64] = from_b64url(SIGNATURE).unwrap().as_slice().try_into().unwrap();
        let message = format!("gospark-relay-v1|host|{HOST_ID}|{NONCE}");
        assert!(relay_key::verify(X, Y, message.as_bytes(), &raw));
        assert!(!relay_key::verify(X, Y, b"another message", &raw));
        // A signature of the shell's, with the vectors' key and with a key it made, checks out the same way.
        let signed = relay_key::sign(&host(), message.as_bytes()).unwrap();
        assert!(relay_key::verify(X, Y, message.as_bytes(), &signed));
        let made = relay_key::make().unwrap();
        assert!(valid_host(&made));
        assert_ne!(made, relay_key::make().unwrap());
        let signed = relay_key::sign(&made, b"hello").unwrap();
        assert!(relay_key::verify(&made.x, &made.y, b"hello", &signed));
        assert!(!relay_key::verify(X, Y, b"hello", &signed));
        assert_eq!(relay_key::sign(&host_with(|h| h.d = "short".into()), b"x"), Err("invalid"));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn has_no_keychain_outside_macos_yet() {
        assert_eq!(read().map(|d| d.is_some()), Err("unavailable".to_string()));
        assert_eq!(change(Ok), Err("unavailable".to_string()));
    }

    #[cfg(target_os = "macos")]
    mod keychain {
        use super::super::{mac, parse, with_device, with_host, with_level, with_touch, without_device, write_text, Level, ACCOUNT};
        /// What the item keeps, whole and checked (None for a damaged one), for the tests that look at what was kept;
        /// the page's own read is `mac::read`.
        fn read(keychain: &security_framework::os::macos::keychain::SecKeychain) -> Result<Option<zeroize::Zeroizing<String>>, &'static str> {
            Ok(read_item(keychain, ACCOUNT)?.and_then(|held| parse(&held)).map(|doc| write_text(&doc).unwrap()))
        }
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
            assert!(read(&s.keychain).unwrap().is_none());
            assert!(read_item(&s.keychain, ACCOUNT).unwrap().is_none());
            mac::change(&s.keychain, |doc| with_host(doc, host())).unwrap();
            mac::change(&s.keychain, |doc| with_device(doc, device(1))).unwrap();
            let text = read(&s.keychain).unwrap().expect("kept");
            let doc = parse(&text).unwrap();
            assert_eq!(doc.host, Some(host()));
            assert_eq!(doc.devices, vec![device(1)]);
            // The items beside it are untouched.
            assert_eq!(session::read(&s.keychain).unwrap().as_deref(), Some(SESSION));
            assert_eq!(read_item(&s.keychain, "shop-cache-key").unwrap().as_deref().map(String::as_str), Some("a".repeat(64).as_str()));
        }

        /// The page is never handed the relay key's private half: a script injected into the window could read every
        /// answer the page gets.
        #[test]
        fn hands_the_page_no_relay_private_key() {
            let s = scratch("remote-keys-page");
            mac::change(&s.keychain, |doc| with_host(doc, host())).unwrap();
            mac::change(&s.keychain, |doc| with_device(doc, device(1))).unwrap();
            let text = mac::read(&s.keychain, true).unwrap().expect("kept");
            assert!(!text.contains(super::D), "the relay key's private half reached the page");
            assert!(text.contains(&device(1).k), "K while the switch is on");
            let off = mac::read(&s.keychain, false).unwrap().expect("kept");
            assert!(!off.contains(super::D) && !off.contains(&device(1).k), "{}", off.as_str());
            assert!(off.contains(super::X) && off.contains(&device(1).id));
        }

        /// The shell signs the relay's challenge for its own key, as the relay checks it, and nothing else.
        #[test]
        fn signs_the_relay_challenge_and_nothing_else() {
            let s = scratch("remote-keys-sign");
            let challenge = format!("gospark-relay-v1|host|{}|{}", super::HOST_ID, super::NONCE);
            assert_eq!(mac::sign_relay(&s.keychain, &challenge), Err("no_key"));
            mac::change(&s.keychain, |doc| with_host(doc, host())).unwrap();
            let signature = mac::sign_relay(&s.keychain, &challenge).unwrap();
            let raw: [u8; 64] = super::super::from_b64url(&signature).unwrap().as_slice().try_into().unwrap();
            assert!(super::super::relay_key::verify(super::X, super::Y, challenge.as_bytes(), &raw));
            for other in [
                format!("gospark-relay-v1|host|{}|{}", "A".repeat(43), super::NONCE),
                format!("gospark-relay-v1|host|{}|{}x", super::HOST_ID, super::NONCE),
                format!("gospark-relay-v1|host|{}|{}|more", super::HOST_ID, super::NONCE),
                format!("gospark-relay-v1|phone|{}|{}", super::HOST_ID, super::NONCE),
                format!("gospark-relay-v1|host|{}|+{}", super::HOST_ID, &super::NONCE[1..]),
                "anything at all".to_string(),
                String::new(),
            ] {
                assert_eq!(mac::sign_relay(&s.keychain, &other), Err("not_a_challenge"), "{other}");
            }
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
        fn keeps_a_phone_level_in_the_item() {
            let s = scratch("remote-keys-level");
            mac::change(&s.keychain, |doc| with_device(doc, device(1))).unwrap();
            mac::change(&s.keychain, |doc| with_level(doc, &device(1).id, Level::Watch, false, false)).unwrap();
            assert_eq!(parse(&read(&s.keychain).unwrap().unwrap()).unwrap().devices[0].level, Level::Watch);
            assert!(mac::read(&s.keychain, false).unwrap().unwrap().contains(r#""level":"watch""#));
            assert_eq!(mac::change(&s.keychain, |doc| with_level(doc, &device(1).id, Level::Answer, true, false)), Err("invalid"));
        }

        #[test]
        fn notes_a_phone_seen_and_forgets_it_with_its_k() {
            let s = scratch("remote-keys-forget");
            mac::change(&s.keychain, |doc| with_device(doc, device(1))).unwrap();
            mac::change(&s.keychain, |doc| with_touch(doc, &device(1).id, 7, 3)).unwrap();
            let doc = parse(&read(&s.keychain).unwrap().unwrap()).unwrap();
            assert_eq!((doc.devices[0].last_seen, doc.devices[0].sign_count), (Some(7), 3));
            assert_eq!(mac::change(&s.keychain, |doc| with_touch(doc, &device(1).id, 8, 2)), Err("counter"));
            mac::change(&s.keychain, |doc| Ok(without_device(doc, &device(1).id))).unwrap();
            let text = read(&s.keychain).unwrap().unwrap();
            assert!(parse(&text).unwrap().devices.is_empty());
            assert!(!text.contains(&device(1).k), "K is gone from the item");
        }

        #[test]
        fn treats_a_damaged_item_as_none_and_replaces_it_on_the_next_change() {
            let s = scratch("remote-keys-damaged");
            write_item(&s.keychain, ACCOUNT, "{\"v\":1,\"host\":null,\"devices\":[{\"id\":\"x\"}]}").unwrap();
            assert!(read(&s.keychain).unwrap().is_none());
            mac::change(&s.keychain, |doc| with_host(doc, host())).unwrap();
            assert_eq!(parse(&read(&s.keychain).unwrap().unwrap()).unwrap().host, Some(host()));
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
            let doc = parse(&read(keychain).unwrap().unwrap()).unwrap();
            assert_eq!(doc.devices.len(), 6);
        }
    }
}
