//! Where the outpost's browser may be: the origins a step names, compared exactly as a browser writes
//! `location.origin`, which is how the vault keeps a sign-in's origins (docs/browser-control.md, "A vault sign-in").
//!
//! The guard is the webview's navigation hook. It allows a navigation only to one of the origins it holds, and
//! remembers that it refused one, so the step that was running is reported failed (`origin_not_allowed`) rather than
//! carrying on somewhere it was never meant to be. wry hands the hook every navigation, the page's own frames as well
//! as the page, with nothing but the address, so a frame from anywhere else is refused too and fails the step the
//! same way.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::Url;

/// The origin of an https address as a browser writes it (scheme, host in lower case, a port other than 443), or
/// None for anything else: another scheme, an account in the address, no host.
pub fn origin_of(address: &str) -> Option<String> {
    let url = Url::parse(address).ok()?;
    https_origin(&url)
}

fn https_origin(url: &Url) -> Option<String> {
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.host_str().is_none() {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

/// Whether `address` is an https page whose origin is one of `origins`.
pub fn allowed(address: &str, origins: &[String]) -> bool {
    origin_of(address).is_some_and(|origin| origins.iter().any(|allowed| *allowed == origin))
}

/// The origins of a step the outpost will go to: each written exactly as a browser writes an https origin, as the
/// vault keeps them. Anything else is dropped, so a malformed one can never widen what the browser may reach.
pub fn clean(origins: &[String]) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    for origin in origins {
        if origin_of(origin).as_deref() == Some(origin.as_str()) && !kept.contains(origin) {
            kept.push(origin.clone());
        }
    }
    kept
}

/// The navigation hook's rule, and what it refused.
#[derive(Default)]
pub struct Guard {
    origins: Mutex<Vec<String>>,
    blocked: AtomicBool,
}

impl Guard {
    /// From now on the browser may be only on `origins`: the step that is running, or that ran last.
    pub fn keep_on(&self, origins: &[String]) {
        *self.origins.lock().unwrap_or_else(|e| e.into_inner()) = origins.to_vec();
    }

    /// The hook: whether the browser may go to `url`. `about:blank` and `about:srcdoc` load nothing from anywhere (a
    /// frame starts on them), so they are allowed; everything else must be an https address on one of the origins.
    pub fn decide(&self, url: &Url) -> bool {
        if url.scheme() == "about" && matches!(url.path(), "blank" | "srcdoc") {
            return true;
        }
        let allowed = https_origin(url).is_some_and(|origin| {
            self.origins.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|allowed| *allowed == origin)
        });
        if !allowed {
            self.blocked.store(true, Ordering::SeqCst);
        }
        allowed
    }

    /// Whether the hook refused a navigation since this was last asked.
    pub fn take_blocked(&self) -> bool {
        self.blocked.swap(false, Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(origins: &[&str]) -> Vec<String> {
        origins.iter().map(|o| o.to_string()).collect()
    }

    #[test]
    fn writes_an_origin_as_a_browser_does_and_only_for_https() {
        assert_eq!(origin_of("https://seller.shopee.co.th/portal/sale?x=1#top").as_deref(), Some("https://seller.shopee.co.th"));
        assert_eq!(origin_of("https://Seller.Shopee.co.th:443/").as_deref(), Some("https://seller.shopee.co.th"));
        assert_eq!(origin_of("https://track.example:8443/a").as_deref(), Some("https://track.example:8443"));
        for not in ["http://seller.shopee.co.th/", "https://user:pw@seller.shopee.co.th/", "https://user@seller.shopee.co.th/",
            "about:blank", "data:text/html,x", "file:///etc/passwd", "javascript:alert(1)", "blob:https://seller.shopee.co.th/1",
            "not a url", ""] {
            assert_eq!(origin_of(not), None, "{not}");
        }
    }

    #[test]
    fn allows_an_address_only_on_one_of_the_origins() {
        let origins = list(&["https://seller.shopee.co.th", "https://accounts.shopee.co.th"]);
        assert!(allowed("https://seller.shopee.co.th/portal/sale/order", &origins));
        assert!(allowed("https://accounts.shopee.co.th/seller/login?next=1", &origins));
        for not in [
            "https://shopee.co.th/",
            "https://seller.shopee.co.th.evil.example/",
            "https://evil.example/https://seller.shopee.co.th",
            "https://seller.shopee.co.th:8443/",
            "http://seller.shopee.co.th/",
            "https://x@seller.shopee.co.th/",
        ] {
            assert!(!allowed(not, &origins), "{not}");
        }
        assert!(!allowed("https://seller.shopee.co.th/", &[]));
    }

    #[test]
    fn keeps_only_origins_written_as_a_browser_writes_them() {
        let kept = clean(&list(&["https://seller.shopee.co.th", "https://Seller.shopee.co.th", "https://a.example/",
            "https://a.example:443", "http://a.example", "https://a.example/path", "https://seller.shopee.co.th", "*", ""]));
        assert_eq!(kept, list(&["https://seller.shopee.co.th"]));
    }

    #[test]
    fn the_guard_allows_only_its_origins_and_remembers_what_it_refused() {
        let guard = Guard::default();
        let url = |u: &str| Url::parse(u).unwrap();
        // Before any step it holds no origin, so nothing is allowed but a blank frame.
        assert!(!guard.decide(&url("https://seller.shopee.co.th/")));
        assert!(guard.take_blocked());
        assert!(!guard.take_blocked(), "asking again finds nothing new");
        guard.keep_on(&list(&["https://seller.shopee.co.th"]));
        assert!(guard.decide(&url("https://seller.shopee.co.th/portal")));
        assert!(guard.decide(&url("about:blank")));
        assert!(guard.decide(&url("about:srcdoc")));
        assert!(!guard.take_blocked());
        for away in ["https://evil.example/", "http://seller.shopee.co.th/", "data:text/html,<p>x", "about:config",
            "blob:https://seller.shopee.co.th/1", "https://u:p@seller.shopee.co.th/", "file:///etc/hosts"] {
            assert!(!guard.decide(&url(away)), "{away}");
            assert!(guard.take_blocked(), "{away}");
        }
        // The next step's origins replace the last ones.
        guard.keep_on(&list(&["https://track.example"]));
        assert!(!guard.decide(&url("https://seller.shopee.co.th/portal")));
        assert!(guard.decide(&url("https://track.example/parcel/1")));
    }
}
