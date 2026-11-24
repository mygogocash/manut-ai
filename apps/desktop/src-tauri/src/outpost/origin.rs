//! Where the outpost's browser may be: the origins a step names, compared exactly as a browser writes
//! `location.origin`, which is how the vault keeps a sign-in's origins (docs/browser-control.md, "A vault sign-in").
//!
//! The guard is the webview's navigation hook. It allows a navigation only to one of the origins it holds, and
//! remembers that it refused one, and whether it was the page's or one of its frames': the page going elsewhere fails
//! the step that was running (`origin_not_allowed`) rather than letting it carry on somewhere it was never meant to be,
//! while a frame it refused stays empty, so what a step reads or types is still the page's own (step.rs says what each
//! kind of step does with each). wry's own hook is told nothing but the address, so on macOS the outpost's browser puts
//! a hook of its own in front of wry's that reads WKWebView's navigation action, which says whether the navigation is
//! for the main frame (browser.rs). Whatever is judged without that, by wry's hook alone, counts as the page's: a frame
//! is never taken for less than it may be.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::Url;

/// What a navigation is for: the page itself (its main frame, or a new window), or one of the page's frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Navigating {
    Page,
    Frame,
}

/// What the guard refused since it was last asked: nothing, only frames of the page, or the page itself, which outweighs
/// any frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub enum Blocked {
    #[default]
    Nothing,
    Frame,
    Page,
}

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
    page: AtomicBool,
    frame: AtomicBool,
}

impl Guard {
    /// From now on the browser may be only on `origins`: the step that is running, or that ran last.
    pub fn keep_on(&self, origins: &[String]) {
        *self.origins.lock().unwrap_or_else(|e| e.into_inner()) = origins.to_vec();
    }

    /// wry's hook, which is told only the address: whether the browser may go to `url`, any refusal counted as the
    /// page's, since it cannot be told from a frame's here.
    pub fn decide(&self, url: &Url) -> bool {
        self.decide_for(url, Navigating::Page)
    }

    /// Whether the browser may go to `url` for the page or one of its frames. `about:blank` and `about:srcdoc` load
    /// nothing from anywhere (a frame starts on them), so they are allowed; everything else must be an https address on
    /// one of the origins.
    pub fn decide_for(&self, url: &Url, navigating: Navigating) -> bool {
        if url.scheme() == "about" && matches!(url.path(), "blank" | "srcdoc") {
            return true;
        }
        let allowed = https_origin(url).is_some_and(|origin| {
            self.origins.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|allowed| *allowed == origin)
        });
        if !allowed {
            self.refuse(navigating);
        }
        allowed
    }

    /// Notes a navigation refused for something that is not even an address the guard can read.
    pub fn refuse(&self, navigating: Navigating) {
        match navigating {
            Navigating::Page => self.page.store(true, Ordering::SeqCst),
            Navigating::Frame => self.frame.store(true, Ordering::SeqCst),
        }
    }

    /// What the hook refused since this was last asked.
    pub fn take_blocked(&self) -> Blocked {
        let page = self.page.swap(false, Ordering::SeqCst);
        let frame = self.frame.swap(false, Ordering::SeqCst);
        match (page, frame) {
            (true, _) => Blocked::Page,
            (false, true) => Blocked::Frame,
            (false, false) => Blocked::Nothing,
        }
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
        assert_eq!(guard.take_blocked(), Blocked::Page);
        assert_eq!(guard.take_blocked(), Blocked::Nothing, "asking again finds nothing new");
        guard.keep_on(&list(&["https://seller.shopee.co.th"]));
        assert!(guard.decide(&url("https://seller.shopee.co.th/portal")));
        assert!(guard.decide(&url("about:blank")));
        assert!(guard.decide(&url("about:srcdoc")));
        assert_eq!(guard.take_blocked(), Blocked::Nothing);
        for away in ["https://evil.example/", "http://seller.shopee.co.th/", "data:text/html,<p>x", "about:config",
            "blob:https://seller.shopee.co.th/1", "https://u:p@seller.shopee.co.th/", "file:///etc/hosts"] {
            assert!(!guard.decide(&url(away)), "{away}");
            assert_eq!(guard.take_blocked(), Blocked::Page, "{away}");
        }
        // The next step's origins replace the last ones.
        guard.keep_on(&list(&["https://track.example"]));
        assert!(!guard.decide(&url("https://seller.shopee.co.th/portal")));
        assert!(guard.decide(&url("https://track.example/parcel/1")));
    }

    #[test]
    fn the_guard_tells_a_refused_frame_from_the_page_and_the_page_outweighs_it() {
        let guard = Guard::default();
        let url = |u: &str| Url::parse(u).unwrap();
        guard.keep_on(&list(&["https://seller.shopee.co.th"]));
        // A frame on the step's origins loads, as the page would; one from anywhere else is refused, as the frame's.
        assert!(guard.decide_for(&url("https://seller.shopee.co.th/widget"), Navigating::Frame));
        assert!(guard.decide_for(&url("about:blank"), Navigating::Frame));
        assert_eq!(guard.take_blocked(), Blocked::Nothing);
        assert!(!guard.decide_for(&url("https://ads.example/frame"), Navigating::Frame));
        assert_eq!(guard.take_blocked(), Blocked::Frame);
        assert_eq!(guard.take_blocked(), Blocked::Nothing);
        // The page refused as well as a frame, in either order, is the page.
        assert!(!guard.decide_for(&url("https://ads.example/frame"), Navigating::Frame));
        assert!(!guard.decide_for(&url("https://evil.example/"), Navigating::Page));
        assert_eq!(guard.take_blocked(), Blocked::Page);
        assert!(!guard.decide_for(&url("https://evil.example/"), Navigating::Page));
        assert!(!guard.decide_for(&url("https://ads.example/frame"), Navigating::Frame));
        assert_eq!(guard.take_blocked(), Blocked::Page);
        // wry's own hook knows only the address: what it refuses counts as the page's, never as less.
        assert!(!guard.decide(&url("https://ads.example/frame")));
        assert_eq!(guard.take_blocked(), Blocked::Page);
        // Something refused that was not even an address is noted for what it was for.
        guard.refuse(Navigating::Frame);
        assert_eq!(guard.take_blocked(), Blocked::Frame);
        guard.refuse(Navigating::Page);
        assert_eq!(guard.take_blocked(), Blocked::Page);
        assert!(Blocked::Page > Blocked::Frame && Blocked::Frame > Blocked::Nothing);
    }
}
