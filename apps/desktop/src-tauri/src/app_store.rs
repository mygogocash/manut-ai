//! The Mac App Store edition (docs/app-store.md). It is the same app built with `MANUT_APP_STORE=1`, which build.rs
//! turns into `cfg(app_store)`; the GitHub build never sets it, so nothing here changes that build.
//!
//! What differs, and why: the App Store updates the app, so the in-app updater is left out (App Review Guideline
//! 2.4.5(vii)); lib.rs registers its plugin only when this is false.

/// Whether this shell was built as the Mac App Store edition.
pub const APP_STORE: bool = cfg!(app_store);
