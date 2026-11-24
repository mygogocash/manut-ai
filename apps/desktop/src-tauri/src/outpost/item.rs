//! This Mac's outpost in the login keychain: one more generic password item beside the API session that api_link.rs
//! keeps (service `xyz.manut.desktop.api`, account `outpost`). It holds the API's origin, the shop, the outpost's id,
//! name and credential, and whether the owner stopped it. Only the shell reads it: no command gives it, or the
//! credential in it, to the page.
//!
//! One item, so this Mac is one outpost at a time: registering it for another shop or another API replaces the item,
//! and the outpost it held stays on that shop's list, asleep, until an operator removes it. Signing out leaves the item:
//! the outpost is the shop's machine, not the person's session, and it runs again only when someone signs in to that
//! same shop on this Mac.

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

pub const ACCOUNT: &str = "outpost";

pub struct Item {
    pub origin: String,
    pub tenant: String,
    pub outpost_id: String,
    pub name: String,
    pub credential: Zeroizing<String>,
    /// The owner pressed Stop: it does not run, even signed in, until they press Start.
    pub stopped: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireOut<'a> {
    v: u8,
    origin: &'a str,
    tenant: &'a str,
    outpost_id: &'a str,
    name: &'a str,
    credential: &'a str,
    stopped: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireIn {
    v: u8,
    origin: String,
    tenant: String,
    outpost_id: String,
    name: String,
    /// Moved into a buffer that is wiped as soon as it is read (`Item::decode`).
    credential: String,
    stopped: bool,
}

/// An outpost credential as the API mints them: `mo1_` and 43 base64url characters.
pub fn is_credential(value: &str) -> bool {
    value.len() == 47 && value.starts_with("mo1_") && value[4..].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// An outpost's id as the vault mints them (a UUID), or close enough to one to name it in a request.
pub fn is_outpost_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// The API's origin, as Settings › Developer keeps it: `https://host[:port]`, or plain http on this computer, no path.
pub fn is_origin(value: &str) -> bool {
    let rest = value.strip_prefix("https://").or_else(|| value.strip_prefix("http://"));
    rest.is_some_and(|rest| !rest.is_empty() && !rest.contains('/')) && crate::api_link::checked_url(&format!("{value}/v1/")).is_ok()
}

fn is_text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= max && !value.chars().any(char::is_control)
}

impl Item {
    pub fn is_for(&self, origin: &str, tenant: &str) -> bool {
        self.origin == origin && self.tenant == tenant
    }

    /// The item as the keychain keeps it, written straight into a buffer sized for it and wiped when dropped.
    pub fn encode(&self) -> Zeroizing<String> {
        let wire = WireOut { v: 1, origin: &self.origin, tenant: &self.tenant, outpost_id: &self.outpost_id, name: &self.name,
            credential: &self.credential, stopped: self.stopped };
        let room = 256 + 2 * (self.origin.len() + self.tenant.len() + self.outpost_id.len() + self.name.len() + self.credential.len());
        let mut out = Zeroizing::new(Vec::with_capacity(room));
        if serde_json::to_writer(&mut *out, &wire).is_err() {
            return Zeroizing::new(String::new());
        }
        Zeroizing::new(String::from_utf8(std::mem::take(&mut *out)).unwrap_or_default())
    }

    /// The keychain's value as an item, or None when it is not one this version wrote.
    pub fn decode(raw: &str) -> Option<Item> {
        let mut wire: WireIn = serde_json::from_str(raw).ok()?;
        let credential = Zeroizing::new(std::mem::take(&mut wire.credential));
        let ok = wire.v == 1 && is_origin(&wire.origin) && is_text(&wire.tenant, 256) && is_outpost_id(&wire.outpost_id) &&
            is_text(&wire.name, 80) && is_credential(&credential);
        ok.then(|| Item { origin: wire.origin, tenant: wire.tenant, outpost_id: wire.outpost_id, name: wire.name, credential,
            stopped: wire.stopped })
    }
}

/// The item the keychain holds, or None (none, or one this version cannot read). `unavailable` outside macOS.
pub fn read() -> Result<Option<Item>, String> {
    #[cfg(target_os = "macos")]
    return mac::read(&crate::api_link::mac::default_keychain()?).map_err(String::from);
    #[cfg(not(target_os = "macos"))]
    return Err("unavailable".into());
}

/// Replaces the item the keychain holds.
pub fn write(item: &Item) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return mac::write(&crate::api_link::mac::default_keychain()?, item).map_err(String::from);
    #[cfg(not(target_os = "macos"))]
    return {
        let _ = item;
        Err("unavailable".into())
    };
}

#[cfg(target_os = "macos")]
pub mod mac {
    use super::{Item, ACCOUNT};
    use crate::api_link::mac::{clear_item, read_item, write_item};
    use security_framework::os::macos::keychain::SecKeychain;

    pub fn read(keychain: &SecKeychain) -> Result<Option<Item>, &'static str> {
        Ok(read_item(keychain, ACCOUNT)?.and_then(|raw| Item::decode(&raw)))
    }

    pub fn write(keychain: &SecKeychain, item: &Item) -> Result<(), &'static str> {
        let value = item.encode();
        if value.is_empty() {
            return Err("keychain");
        }
        write_item(keychain, ACCOUNT, &value)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn clear(keychain: &SecKeychain) -> Result<(), &'static str> {
        clear_item(keychain, ACCOUNT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn sample() -> Item {
        Item {
            origin: "https://dev.manut.xyz".into(),
            tenant: "pilot:5f0e7c1e-2b55-4c1d-9d33-1f2a3b4c5d6e".into(),
            outpost_id: "0c7d6a4e-8f1b-4e2a-9c3d-5b6a7f8e9d0c".into(),
            name: "This Mac".into(),
            credential: Zeroizing::new(format!("mo1_{}", "Ab9_-".repeat(8) + "xyz")),
            stopped: false,
        }
    }

    #[test]
    fn writes_and_reads_back_an_item_this_version_wrote() {
        let item = sample();
        assert!(is_credential(&item.credential));
        let raw = item.encode();
        let back = Item::decode(&raw).expect("decoded");
        assert_eq!((back.origin.as_str(), back.tenant.as_str(), back.outpost_id.as_str(), back.name.as_str(), back.stopped),
            (item.origin.as_str(), item.tenant.as_str(), item.outpost_id.as_str(), "This Mac", false));
        assert_eq!(back.credential.as_str(), item.credential.as_str());
        assert!(back.is_for("https://dev.manut.xyz", &item.tenant));
        assert!(!back.is_for("https://dev.manut.xyz", "apple:someone-else"));
        assert!(!back.is_for("http://localhost:8787", &item.tenant));
    }

    #[test]
    fn reads_nothing_it_did_not_write() {
        let good: serde_json::Value = serde_json::from_str(&sample().encode()).unwrap();
        for (key, bad) in [("v", serde_json::json!(2)), ("origin", serde_json::json!("https://dev.manut.xyz/v1")),
            ("origin", serde_json::json!("http://dev.manut.xyz")), ("origin", serde_json::json!("ftp://x")),
            ("tenant", serde_json::json!(" ")), ("outpostId", serde_json::json!("../x")), ("name", serde_json::json!("a\nb")),
            ("credential", serde_json::json!("mo1_short")), ("credential", serde_json::json!(format!("mo2_{}", "a".repeat(43)))),
            ("stopped", serde_json::json!("no"))] {
            let mut wire = good.clone();
            wire[key] = bad.clone();
            assert!(Item::decode(&wire.to_string()).is_none(), "{key} = {bad}");
        }
        assert!(Item::decode("").is_none());
        assert!(Item::decode("{}").is_none());
        assert!(Item::decode(r#"{"v":1,"accessToken":"a"}"#).is_none(), "the session's item is not an outpost's");
        assert!(is_origin("http://localhost:8787") && is_origin("https://dev.manut.xyz:8443") && !is_origin("https://"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn keeps_this_macs_outpost_in_its_own_keychain_item_beside_the_session() {
        use crate::api_link::mac as session;
        use crate::api_link::scratch_keychain::scratch;
        let s = scratch("outpost");
        assert!(mac::read(&s.keychain).unwrap().is_none());
        session::write(&s.keychain, r#"{"v":1,"accessToken":"a-1"}"#).unwrap();
        let mut item = sample();
        mac::write(&s.keychain, &item).unwrap();
        let back = mac::read(&s.keychain).unwrap().expect("kept");
        assert_eq!(back.credential.as_str(), item.credential.as_str());
        // Stopping it replaces the item, and the session's item is untouched by any of it.
        item.stopped = true;
        mac::write(&s.keychain, &item).unwrap();
        assert!(mac::read(&s.keychain).unwrap().expect("kept").stopped);
        assert_eq!(session::read(&s.keychain).unwrap().as_deref(), Some(r#"{"v":1,"accessToken":"a-1"}"#));
        mac::clear(&s.keychain).unwrap();
        assert!(mac::read(&s.keychain).unwrap().is_none());
        assert!(session::read(&s.keychain).unwrap().is_some());
        // A session in the outpost's place is not read as an outpost.
        crate::api_link::mac::write_item(&s.keychain, ACCOUNT, r#"{"v":1,"accessToken":"a-1"}"#).unwrap();
        assert!(mac::read(&s.keychain).unwrap().is_none());
    }
}
