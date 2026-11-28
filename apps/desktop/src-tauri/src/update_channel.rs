//! The update channel (item 111, owner 27 Nov 2026): Stable or Nightly, chosen in Settings › General › Updates and kept
//! on this Mac by the page.
//!
//! Why this is Rust and not one more option on the page's `check()`: `@tauri-apps/plugin-updater` 2.14.1's `check` takes
//! only headers, timeout, proxy and target, so the page cannot name an endpoint. `tauri-plugin-updater` 2.14.1 does let
//! the shell: `UpdaterBuilder::endpoints` overrides the `endpoints` in tauri.conf.json for one check. So the page names
//! a channel and this file maps it to an address. The page never sends an address, so it cannot point the updater
//! anywhere else, and whatever a feed names still installs only if its signature verifies against the key pinned in
//! the build's tauri.conf.json. Since item 141 the two channels have different keys: the nightly signs with a key of its
//! own and writes its public half, and Nightly's feed as the endpoint, into each nightly build's config, so a stable
//! build refuses a nightly's files, and a nightly build trusts and reads only the nightly's (docs/releasing.md).
//!
//! Stable keeps using the plugin's own `check` command with tauri.conf.json's endpoint, so nothing changes for people who
//! never open the setting. Only Nightly comes here. The update this makes goes into the same resource table the plugin's
//! own `check` uses, so the plugin's `download` and `install` commands act on it unchanged.

use serde::Serialize;
use tauri::{Manager, Webview};
use tauri_plugin_updater::UpdaterExt;

/// Stable's feed, the same address tauri.conf.json carries. GitHub serves `releases/latest` from the newest release that is
/// published and not a prerelease, so it moves only when the owner publishes. A test pins the two together.
pub const STABLE_FEED: &str = "https://github.com/mygogocash/manut-ai/releases/latest/download/latest.json";
/// Nightly's feed: one fixed prerelease, tagged `nightly`, whose only job is to hold `nightly.json`. GitHub has no
/// "latest prerelease" address, so the nightly workflow (.github/workflows/nightly-desktop.yml) rewrites this file after
/// every good build; it names the files of that night's `nightly-<date>` release.
pub const NIGHTLY_FEED: &str = "https://github.com/mygogocash/manut-ai/releases/download/nightly/nightly.json";

/// The feed a channel reads, or None for a name this build does not know (the page only ever sends the two).
pub fn feed_url(channel: &str) -> Option<&'static str> {
    match channel {
        "stable" => Some(STABLE_FEED),
        "nightly" => Some(NIGHTLY_FEED),
        _ => None,
    }
}

/// What the page's `Update` class is built from: the plugin's own `check` returns exactly these fields.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    rid: tauri::ResourceId,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
}

/// Looks for an update on `channel`'s feed. None means this is the newest build on that channel.
#[tauri::command]
pub async fn check_update_channel(webview: Webview, channel: String, timeout: Option<u64>) -> Result<Option<Metadata>, String> {
    // The App Store edition has no updater plugin registered (lib.rs), and asking its state would panic.
    if crate::app_store::APP_STORE {
        return Err("This edition is updated by the Mac App Store".into());
    }
    let feed = feed_url(&channel).ok_or_else(|| format!("Unknown update channel: {channel}"))?;
    let url = tauri::Url::parse(feed).map_err(|e| e.to_string())?;
    let mut builder = webview.updater_builder().endpoints(vec![url]).map_err(|e| e.to_string())?;
    if let Some(ms) = timeout {
        builder = builder.timeout(std::time::Duration::from_millis(ms));
    }
    let updater = builder.build().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let meta = Metadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date: None,
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        rid: webview.resources_table().add(update),
    };
    Ok(Some(meta))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_channel_reads_its_own_https_feed_and_an_unknown_one_reads_none() {
        assert_eq!(feed_url("stable"), Some(STABLE_FEED));
        assert_eq!(feed_url("nightly"), Some(NIGHTLY_FEED));
        assert_ne!(STABLE_FEED, NIGHTLY_FEED);
        for bad in ["", "Nightly", "beta", "https://example.com/x.json"] {
            assert_eq!(feed_url(bad), None, "{bad}");
        }
        for feed in [STABLE_FEED, NIGHTLY_FEED] {
            assert!(feed.starts_with("https://github.com/mygogocash/manut-ai/releases/"), "{feed}");
            tauri::Url::parse(feed).unwrap();
        }
    }

    #[test]
    fn stable_is_the_endpoint_tauri_conf_json_carries() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["plugins"]["updater"]["endpoints"], serde_json::json!([STABLE_FEED]));
    }
}
