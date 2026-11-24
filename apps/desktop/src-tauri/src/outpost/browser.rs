//! The outpost's browser: a Tauri webview window of its own, labelled `outpost`, never the app's main window.
//!
//! - **No way into the app.** Tauri 2 answers a command from a page that is not the app's own only when a capability
//!   names both the window and the page's address (its `remote` list); no capability names this window or any remote
//!   page, so the sites it shows reach none of the app's commands or plugins, and a test reads every capability to keep
//!   it so (mod.rs). lib.rs also refuses any command from this webview before Tauri's own check is even asked. Events
//!   reach only webviews that listened for them, which a remote page cannot do, and channel data is kept per webview.
//! - **Reading the page** goes through WKWebView's own `callAsyncJavaScript` (through `with_webview`), which runs a
//!   script in the page's main frame, in a JavaScript world of the outpost's own, and hands back its result. Nothing is
//!   opened from the page to the app. The arguments travel as values, never written into a script's text, so a password
//!   is never part of any script WebKit keeps.
//! - **Staying on the step's origins.** The guard (origin.rs) is the window's navigation hook. Pop-ups are refused,
//!   nothing is downloaded (with no download handler wry cancels every download), and the web inspector is off.
//! - **Nothing kept on disk.** The window is incognito: a site's cookies and storage live in memory while it is open,
//!   and are gone when the outpost stops.
//! - **Seen.** It opens beside the app without taking focus, and stays open while the outpost runs, so the owner can
//!   watch the team read the shop's sites (docs/decisions.md, 24 Nov 2026).

use super::api::Failure;
use super::origin::{self, Guard};
use super::step::{self, Browser, Until};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use zeroize::Zeroizing;

/// The outpost's window. No capability may name it (mod.rs's tests).
pub const LABEL: &str = "outpost";

/// How often a wait looks at the window again.
const POLL: Duration = Duration::from_millis(200);
/// A navigation that has not loaded anything after this long, and is not loading, failed (no answer, no such site, a
/// certificate WebKit refused): WebKit says nothing more, and wry passes on no failure.
const NO_LOAD: Duration = Duration::from_secs(3);

type Answer = Result<String, Failure>;

pub struct WebviewBrowser {
    app: AppHandle,
    /// The window's title, in the page's language.
    title: Mutex<String>,
    guard: Arc<Guard>,
    /// Pages loaded to the end in the window, counted by its page-load hook.
    loads: Arc<AtomicU64>,
}

impl WebviewBrowser {
    pub fn new(app: AppHandle, title: &str) -> Self {
        WebviewBrowser { app, title: Mutex::new(title.to_owned()), guard: Arc::new(Guard::default()), loads: Arc::new(AtomicU64::new(0)) }
    }

    pub fn set_title(&self, title: &str) {
        *self.title.lock().unwrap_or_else(|e| e.into_inner()) = title.to_owned();
        if let Some(window) = self.window() {
            let _ = window.set_title(title);
        }
    }

    fn window(&self) -> Option<WebviewWindow> {
        self.app.get_webview_window(LABEL)
    }

    fn create(&self, url: Url) -> Result<WebviewWindow, Failure> {
        let guard = self.guard.clone();
        let loads = self.loads.clone();
        let title = self.title.lock().unwrap_or_else(|e| e.into_inner()).clone();
        WebviewWindowBuilder::new(&self.app, LABEL, WebviewUrl::External(url))
            .title(title)
            .inner_size(1100.0, 760.0)
            .focused(false)
            .visible(true)
            .incognito(true)
            .devtools(false)
            .on_navigation(move |url| guard.decide(url))
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_page_load(move |_, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    loads.fetch_add(1, Ordering::SeqCst);
                }
            })
            .build()
            .map_err(|_| Failure::BrowserError)
    }
}

impl Browser for WebviewBrowser {
    fn open(&self, url: &str, origins: &[String], until: &Until) -> Result<(), Failure> {
        let target = Url::parse(url).map_err(|_| Failure::BrowserError)?;
        self.guard.keep_on(origins);
        let before = self.loads.load(Ordering::SeqCst);
        match self.window() {
            Some(window) => window.navigate(target).map_err(|_| Failure::BrowserError)?,
            None => drop(self.create(target)?),
        }
        let started = Instant::now();
        loop {
            if until.over() {
                if let Some(window) = self.window() {
                    stop_loading(&window);
                }
                return Err(until.failure());
            }
            std::thread::sleep(POLL);
            // The owner closed the window under the step.
            let window = self.window().ok_or(Failure::BrowserError)?;
            if loading(&window).unwrap_or(true) {
                continue;
            }
            if self.loads.load(Ordering::SeqCst) > before {
                let address = window.url().map(|u| u.to_string()).unwrap_or_default();
                return if origin::allowed(&address, origins) { Ok(()) } else { Err(Failure::OriginNotAllowed) };
            }
            if started.elapsed() > NO_LOAD {
                return Err(Failure::PageUnavailable);
            }
        }
    }

    fn address(&self) -> Option<String> {
        self.window()?.url().ok().map(|url| url.to_string())
    }

    fn loading(&self) -> bool {
        self.window().and_then(|window| loading(&window)).unwrap_or(false)
    }

    fn keep_on(&self, origins: &[String]) {
        self.guard.keep_on(origins);
    }

    fn call(&self, body: &'static str, args: Vec<(&'static str, Zeroizing<String>)>, until: &Until) -> Result<String, Failure> {
        let window = self.window().ok_or(Failure::PageUnavailable)?;
        let (tx, rx) = mpsc::channel();
        evaluate(&window, step::script(body), args, tx)?;
        loop {
            match rx.recv_timeout(POLL) {
                Ok(answer) => return answer,
                Err(RecvTimeoutError::Timeout) if until.over() => return Err(until.failure()),
                Err(RecvTimeoutError::Timeout) => {}
                // The window went before WebKit answered.
                Err(RecvTimeoutError::Disconnected) => return Err(Failure::BrowserError),
            }
        }
    }

    fn take_blocked(&self) -> bool {
        self.guard.take_blocked()
    }
}

/// Closes the outpost's window, if it is open: the outpost stopped, the person signed out, or the app is quitting.
pub fn close(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
}

/// Whether the window's page is loading, asked of WKWebView on the main thread. None when it could not be asked.
fn loading(window: &WebviewWindow) -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = mpsc::channel();
        window
            // SAFETY: Tauri runs the closure on the main thread, with the window's WKWebView alive for the call.
            .with_webview(move |webview| {
                let _ = tx.send(unsafe { mac::is_loading(webview.inner()) });
            })
            .ok()?;
        rx.recv_timeout(Duration::from_secs(5)).ok()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        None
    }
}

fn stop_loading(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: as in `loading`.
        let _ = window.with_webview(|webview| unsafe { mac::stop_loading(webview.inner()) });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
    }
}

/// Runs `source` in the window's page through WKWebView, sending its answer to `tx`.
fn evaluate(window: &WebviewWindow, source: String, args: Vec<(&'static str, Zeroizing<String>)>, tx: Sender<Answer>) -> Result<(), Failure> {
    #[cfg(target_os = "macos")]
    return window
        // SAFETY: Tauri runs the closure on the main thread, with the window's WKWebView alive for the call.
        .with_webview(move |webview| unsafe { mac::call_async(webview.inner(), &source, args, tx) })
        .map_err(|_| Failure::BrowserError);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, source, args, tx);
        Err(Failure::BrowserError)
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{Answer, Failure};
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::MainThreadMarker;
    use objc2_foundation::{NSDictionary, NSError, NSString};
    use objc2_web_kit::{WKContentWorld, WKWebView};
    use std::ffi::c_void;
    use std::sync::mpsc::Sender;
    use zeroize::Zeroizing;

    /// Runs `source` as an async function in the page's main frame, in WebKit's default client world (a JavaScript
    /// world apart from the page's own), with `args` as its string arguments, and sends what it returns, which must be
    /// a string, to `tx`.
    ///
    /// SAFETY: on the main thread, with `webview` a live WKWebView (Tauri's `PlatformWebview::inner`).
    pub unsafe fn call_async(webview: *mut c_void, source: &str, args: Vec<(&'static str, Zeroizing<String>)>, tx: Sender<Answer>) {
        let (Some(mtm), false) = (MainThreadMarker::new(), webview.is_null()) else {
            let _ = tx.send(Err(Failure::BrowserError));
            return;
        };
        // SAFETY: the caller's promise.
        let webview: &WKWebView = unsafe { &*(webview as *const WKWebView) };
        let keys: Vec<Retained<NSString>> = args.iter().map(|(key, _)| NSString::from_str(key)).collect();
        let values: Vec<Retained<NSString>> = args.iter().map(|(_, value)| NSString::from_str(value)).collect();
        // The Rust copies of the arguments, a password among them, are wiped here: WebKit holds its own now.
        drop(args);
        let key_refs: Vec<&NSString> = keys.iter().map(|key| &**key).collect();
        let value_refs: Vec<&AnyObject> = values.iter().map(|value| -> &AnyObject { value }).collect();
        let arguments = NSDictionary::<NSString, AnyObject>::from_slices(&key_refs, &value_refs);
        let done: RcBlock<dyn Fn(*mut AnyObject, *mut NSError)> = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
            // WebKit's error can carry what the page threw; it is neither read nor kept.
            let answer = if error.is_null() { string_of(result).ok_or(Failure::BrowserError) } else { Err(Failure::BrowserError) };
            let _ = tx.send(answer);
        });
        // SAFETY: on the main thread, with live objects; the arguments are all NSStrings, as the method expects of a
        // dictionary of property-list values.
        unsafe {
            let world = WKContentWorld::defaultClientWorld(mtm);
            webview.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
                &NSString::from_str(source),
                Some(&arguments),
                None,
                &world,
                Some(&*done),
            );
        }
    }

    /// What a script returned, when it returned a string.
    fn string_of(result: *mut AnyObject) -> Option<String> {
        // SAFETY: WebKit hands the completion handler a valid object or null.
        let object = unsafe { result.as_ref() }?;
        Some(object.downcast_ref::<NSString>()?.to_string())
    }

    /// SAFETY: as for `call_async`.
    pub unsafe fn is_loading(webview: *mut c_void) -> bool {
        !webview.is_null() && unsafe { (*(webview as *const WKWebView)).isLoading() }
    }

    /// SAFETY: as for `call_async`.
    pub unsafe fn stop_loading(webview: *mut c_void) {
        if !webview.is_null() {
            unsafe { (*(webview as *const WKWebView)).stopLoading() }
        }
    }
}
