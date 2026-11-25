//! The key the last good read of the shop is sealed with (shop_cache.rs keeps the file; the page seals and opens it with
//! AES-GCM, src/runtime/http/seal.ts). It is 256 random bits from the system's own source, made the first time a read is
//! kept and held only in the login keychain: one more generic password item beside the API session (service
//! `xyz.manut.desktop.api`, account `shop-cache-key`), written as 64 lowercase hex digits. Never in a file and never in a
//! log, so a copy of the file (a backup, a sync folder, another account on a shared Mac) holds nothing it can be read
//! with.
//!
//! The page asks for it with `shop_cache_seal_key` and imports it at once as a key script cannot read back, as it is handed
//! the session; it deletes it with `shop_cache_seal_key_clear` whenever it forgets the file (signing out, a session the API
//! ended, a new sign-in, a move to Practice or another origin), so a copy of the file that outlived the forgetting can never
//! be opened. The item is made by this app, so macOS lets this app read it without asking and asks the person before any
//! other program reads it. macOS only for now: elsewhere the commands answer `unavailable` and the page keeps no copy at
//! all rather than a plain one.

use zeroize::Zeroizing;

/// The keychain item's account, beside `session` (api_link.rs) and `outpost` (outpost/item.rs).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const ACCOUNT: &str = "shop-cache-key";

/// AES-256: 32 bytes.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const KEY_BYTES: usize = 32;

/// A key as this module writes it: 64 lowercase hex digits, and nothing else.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn is_key(value: &str) -> bool {
    value.len() == KEY_BYTES * 2 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `bytes` as lowercase hex, written straight into a buffer sized for it, so no reallocation leaves a copy, and wiped
/// when dropped.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn hex(bytes: &[u8]) -> Zeroizing<String> {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = Zeroizing::new(String::with_capacity(bytes.len() * 2));
    for b in bytes {
        out.push(DIGITS[usize::from(b >> 4)] as char);
        out.push(DIGITS[usize::from(b & 0x0f)] as char);
    }
    out
}

/// The key the keychain holds. When it holds none, or holds something that is not a key, and `make` is set, a new one is
/// made and kept first; without `make`, `None`. `unavailable` on a computer with no keychain support (anything but macOS
/// today), and `keychain` when the keychain refused (locked, or the person said no).
pub fn get(make: bool) -> Result<Option<Zeroizing<String>>, String> {
    #[cfg(target_os = "macos")]
    return mac::get(&crate::api_link::mac::default_keychain()?, make).map_err(String::from);
    #[cfg(not(target_os = "macos"))]
    return {
        let _ = make;
        Err("unavailable".into())
    };
}

/// Deletes the key, so nothing sealed with it can be opened again. Deleting one that is not there is not an error.
pub fn clear() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return mac::clear(&crate::api_link::mac::default_keychain()?).map_err(String::from);
    #[cfg(not(target_os = "macos"))]
    return Err("unavailable".into());
}

#[cfg(target_os = "macos")]
pub mod mac {
    use super::{hex, is_key, ACCOUNT, KEY_BYTES};
    use crate::api_link::mac::{clear_item, read_item, write_item};
    use security_framework::os::macos::keychain::SecKeychain;
    use security_framework::random::SecRandom;
    use std::sync::Mutex;
    use zeroize::Zeroizing;

    /// Looking for the key and making it are one step under this lock, so two calls at once never make two keys, one of
    /// which the other then replaced: a read sealed with the replaced one could never be opened.
    static LOCK: Mutex<()> = Mutex::new(());

    pub fn get(keychain: &SecKeychain, make: bool) -> Result<Option<Zeroizing<String>>, &'static str> {
        let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(held) = read_item(keychain, ACCOUNT)? {
            if is_key(&held) {
                return Ok(Some(held));
            }
        }
        if !make {
            return Ok(None);
        }
        let mut bytes = Zeroizing::new([0u8; KEY_BYTES]);
        SecRandom::default().copy_bytes(&mut bytes[..]).map_err(|_| "random")?;
        let key = hex(&bytes[..]);
        write_item(keychain, ACCOUNT, &key)?;
        Ok(Some(key))
    }

    pub fn clear(keychain: &SecKeychain) -> Result<(), &'static str> {
        let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_item(keychain, ACCOUNT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_is_sixty_four_lowercase_hex_digits_and_nothing_else() {
        assert!(is_key(&"0123456789abcdef".repeat(4)));
        let short = "a".repeat(63);
        let long = "a".repeat(65);
        let upper = "A".repeat(64);
        let spaced = format!("{} ", "a".repeat(63));
        let other = format!("{}g", "a".repeat(63));
        for bad in ["", "not a key", short.as_str(), long.as_str(), upper.as_str(), spaced.as_str(), other.as_str()] {
            assert!(!is_key(bad), "{bad}");
        }
    }

    #[test]
    fn writes_bytes_as_lowercase_hex_two_digits_each() {
        assert_eq!(hex(&[0x00, 0x0f, 0xa5, 0xff, 0x10]).as_str(), "000fa5ff10");
        assert_eq!(hex(&[]).as_str(), "");
        assert!(is_key(&hex(&[0xab; KEY_BYTES])));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn has_no_keychain_outside_macos_yet() {
        assert_eq!(get(false).map(|k| k.is_some()), Err("unavailable".to_string()));
        assert_eq!(get(true).map(|k| k.is_some()), Err("unavailable".to_string()));
        assert_eq!(clear(), Err("unavailable".to_string()));
    }

    #[cfg(target_os = "macos")]
    mod keychain {
        use super::super::{is_key, mac, ACCOUNT};
        use crate::api_link::mac as session;
        use crate::api_link::mac::{read_item, write_item};
        use crate::api_link::scratch_keychain::scratch;

        const SESSION: &str = r#"{"v":1,"accessToken":"a-1"}"#;
        /// The outpost's account (outpost/item.rs), whose module is its own.
        const OUTPOST: &str = "outpost";

        #[test]
        fn makes_one_key_only_when_asked_and_gives_the_same_one_after() {
            let s = scratch("cache-key");
            // A look makes nothing: with no key there is nothing a kept read could have been sealed with.
            assert!(mac::get(&s.keychain, false).unwrap().is_none());
            assert!(read_item(&s.keychain, ACCOUNT).unwrap().is_none());
            let key = mac::get(&s.keychain, true).unwrap().expect("made");
            assert!(is_key(&key), "{}", key.len());
            // It is the keychain's item, and every later call gives that one, made or not.
            assert_eq!(read_item(&s.keychain, ACCOUNT).unwrap().as_deref().map(String::as_str), Some(key.as_str()));
            assert_eq!(mac::get(&s.keychain, false).unwrap().as_deref().map(String::as_str), Some(key.as_str()));
            assert_eq!(mac::get(&s.keychain, true).unwrap().as_deref().map(String::as_str), Some(key.as_str()));
        }

        #[test]
        fn keeps_its_own_item_beside_the_session_and_the_outpost_and_deletes_only_that() {
            let s = scratch("cache-key-beside");
            session::write(&s.keychain, SESSION).unwrap();
            write_item(&s.keychain, OUTPOST, "the outpost's item").unwrap();
            let key = mac::get(&s.keychain, true).unwrap().expect("made");
            // Neither item beside it is read as the key, or changed by making it.
            assert_eq!(session::read(&s.keychain).unwrap().as_deref(), Some(SESSION));
            assert_ne!(key.as_str(), SESSION);
            mac::clear(&s.keychain).unwrap();
            assert!(mac::get(&s.keychain, false).unwrap().is_none());
            // Deleting what is not there is not an error.
            mac::clear(&s.keychain).unwrap();
            // The session and the outpost are untouched by the deleting.
            assert_eq!(session::read(&s.keychain).unwrap().as_deref(), Some(SESSION));
            assert_eq!(read_item(&s.keychain, OUTPOST).unwrap().as_deref().map(String::as_str), Some("the outpost's item"));
            // A key made after the deleting is a new one: nothing sealed before it opens with it.
            let next = mac::get(&s.keychain, true).unwrap().expect("made again");
            assert!(is_key(&next));
            assert_ne!(next.as_str(), key.as_str());
        }

        #[test]
        fn takes_nothing_that_is_not_a_key_and_replaces_it_only_when_asked_to_make_one() {
            let s = scratch("cache-key-odd");
            let upper = "A".repeat(64);
            let short = "a".repeat(63);
            for odd in ["not a key", upper.as_str(), short.as_str(), SESSION] {
                write_item(&s.keychain, ACCOUNT, odd).unwrap();
                assert!(mac::get(&s.keychain, false).unwrap().is_none(), "{odd}");
                // A look leaves the item as it was.
                assert_eq!(read_item(&s.keychain, ACCOUNT).unwrap().as_deref().map(String::as_str), Some(odd));
                let key = mac::get(&s.keychain, true).unwrap().expect("made");
                assert!(is_key(&key), "{odd}");
                assert_eq!(mac::get(&s.keychain, false).unwrap().as_deref().map(String::as_str), Some(key.as_str()));
            }
        }

        #[test]
        fn each_key_is_new_random_bits() {
            let mut seen = std::collections::HashSet::new();
            for n in 0..8 {
                let s = scratch(&format!("cache-key-random-{n}"));
                let key = mac::get(&s.keychain, true).unwrap().expect("made");
                assert!(key.as_str() != "0".repeat(64), "all zeros");
                assert!(seen.insert(key.as_str().to_owned()), "the same key twice");
            }
            // Every hex digit turns up somewhere in eight keys of 64 digits, unless the bits are not random.
            let digits: std::collections::HashSet<char> = seen.iter().flat_map(|k| k.chars()).collect();
            assert_eq!(digits.len(), 16, "{digits:?}");
        }

        #[test]
        fn calls_at_the_same_time_make_one_key_between_them() {
            let s = scratch("cache-key-race");
            let keychain = &s.keychain;
            let keys: Vec<String> = std::thread::scope(|scope| {
                let calls: Vec<_> = (0..6).map(|_| scope.spawn(move || mac::get(keychain, true).unwrap().expect("made").as_str().to_owned())).collect();
                calls.into_iter().map(|c| c.join().unwrap()).collect()
            });
            assert!(keys.iter().all(|k| k == &keys[0]), "{keys:?}");
            assert_eq!(read_item(keychain, ACCOUNT).unwrap().as_deref().map(String::as_str), Some(keys[0].as_str()));
        }
    }
}
