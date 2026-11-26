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
//! - **The page told from its frames.** wry's hook is told only a navigation's address. On macOS a hook of the outpost's
//!   own is put in front of wry's as the WKWebView's navigation delegate (`hook` below): it reads the navigation
//!   action's target frame, so the guard knows whether the page or one of its frames was refused, cancels what the guard
//!   refuses, and hands everything else to wry's delegate unchanged, which then asks wry's hook as before. If it could not
//!   be put in place, wry's hook alone judges, and every refusal counts as the page's.
//! - **Nothing kept on disk.** The window is incognito: a site's cookies and storage live in memory while it is open,
//!   and are gone when the outpost stops.
//! - **Seen.** It opens beside the app without taking focus, and stays open while the outpost runs, so the owner can
//!   watch the team read the shop's sites (docs/decisions.md, 24 Nov 2026).

use super::api::Failure;
use super::origin::{self, Blocked, Guard};
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
        let window = WebviewWindowBuilder::new(&self.app, LABEL, WebviewUrl::External(url))
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
            .map_err(|_| Failure::BrowserError)?;
        // As soon as the window is there. A navigation WebKit asks about before this lands is judged by wry's hook
        // alone, which counts any refusal as the page's: stricter, never looser.
        tell_frames_apart(&window, self.guard.clone());
        Ok(window)
    }
}

/// Puts the hook that knows frames in front of wry's (macOS only; elsewhere wry's hook alone judges).
fn tell_frames_apart(window: &WebviewWindow, guard: Arc<Guard>) {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: Tauri runs the closure on the main thread, with the window's WKWebView alive for the call.
        let _ = window.with_webview(move |webview| unsafe { hook::install(webview.inner(), guard) });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, guard);
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

    fn blank(&self, until: &Until) -> Result<(), Failure> {
        let window = self.window().ok_or(Failure::BrowserError)?;
        let empty = Url::parse("about:blank").map_err(|_| Failure::BrowserError)?;
        window.navigate(empty).map_err(|_| Failure::BrowserError)?;
        loop {
            if until.over() {
                return Err(until.failure());
            }
            std::thread::sleep(POLL);
            // The owner closed the window under the step.
            let window = self.window().ok_or(Failure::BrowserError)?;
            if loading(&window).unwrap_or(true) {
                continue;
            }
            if window.url().is_ok_and(|url| url.as_str() == "about:blank") {
                return Ok(());
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

    fn take_blocked(&self) -> Blocked {
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

/// The hook that knows frames (macOS). WebKit asks the WKWebView's navigation delegate about every navigation, with a
/// navigation action that names the frame it is for, and wry's delegate passes only the address on to wry's hook. This
/// puts a delegate of the outpost's own in that place: it asks the guard with the frame, cancels what the guard refuses,
/// and hands everything else, and every other message wry's delegate takes, to wry's delegate as it came.
///
/// It lives as long as the webview: the webview's delegate property does not keep what it names, so the hook is kept on
/// the WKWebView itself (an associated object), and it holds wry's delegate weakly, so neither keeps the other, or the
/// webview, alive. wry keeps its own delegate for as long as the webview lives; should it be gone, nothing is let through.
#[cfg(target_os = "macos")]
mod hook {
    use super::super::origin::{Guard, Navigating};
    use block2::DynBlock;
    use objc2::rc::{Retained, Weak};
    use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject, Sel};
    use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_web_kit::{
        WKDownload, WKNavigation, WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate, WKNavigationResponse,
        WKNavigationResponsePolicy, WKWebView,
    };
    use std::ffi::c_void;
    use std::sync::Arc;
    use tauri::Url;

    pub struct Ivars {
        guard: Arc<Guard>,
        wry: Weak<ProtocolObject<dyn WKNavigationDelegate>>,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and the hook does not implement Drop.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = Ivars]
        struct Hook;

        // SAFETY: NSObjectProtocol has no safety requirements.
        unsafe impl NSObjectProtocol for Hook {}

        // SAFETY: each method's signature is the protocol's, as wry's delegate declares it, and each handler is called
        // exactly once, by the hook or by wry's delegate.
        unsafe impl WKNavigationDelegate for Hook {
            #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
            fn decide(&self, webview: &WKWebView, action: &WKNavigationAction, handler: &DynBlock<dyn Fn(WKNavigationActionPolicy)>) {
                // SAFETY: WebKit hands the method a live navigation action.
                let (address, navigating) = unsafe { what(action) };
                let guard = &self.ivars().guard;
                let allowed = match address.as_deref().map(Url::parse) {
                    Some(Ok(url)) => guard.decide_for(&url, navigating),
                    _ => {
                        guard.refuse(navigating);
                        false
                    }
                };
                match self.wry(sel!(webView:decidePolicyForNavigationAction:decisionHandler:)) {
                    // SAFETY: wry's delegate takes this message (just asked), with what WebKit handed the hook.
                    Some(wry) if allowed => unsafe { wry.webView_decidePolicyForNavigationAction_decisionHandler(webview, action, handler) },
                    _ => handler.call((WKNavigationActionPolicy::Cancel,)),
                }
            }

            #[unsafe(method(webView:decidePolicyForNavigationResponse:decisionHandler:))]
            fn respond(&self, webview: &WKWebView, response: &WKNavigationResponse, handler: &DynBlock<dyn Fn(WKNavigationResponsePolicy)>) {
                match self.wry(sel!(webView:decidePolicyForNavigationResponse:decisionHandler:)) {
                    // SAFETY: as above.
                    Some(wry) => unsafe { wry.webView_decidePolicyForNavigationResponse_decisionHandler(webview, response, handler) },
                    None => handler.call((WKNavigationResponsePolicy::Cancel,)),
                }
            }

            #[unsafe(method(webView:didCommitNavigation:))]
            fn committed(&self, webview: &WKWebView, navigation: Option<&WKNavigation>) {
                if let Some(wry) = self.wry(sel!(webView:didCommitNavigation:)) {
                    // SAFETY: as above.
                    unsafe { wry.webView_didCommitNavigation(webview, navigation) }
                }
            }

            #[unsafe(method(webView:didFinishNavigation:))]
            fn finished(&self, webview: &WKWebView, navigation: Option<&WKNavigation>) {
                if let Some(wry) = self.wry(sel!(webView:didFinishNavigation:)) {
                    // SAFETY: as above.
                    unsafe { wry.webView_didFinishNavigation(webview, navigation) }
                }
            }

            #[unsafe(method(webView:navigationAction:didBecomeDownload:))]
            fn action_download(&self, webview: &WKWebView, action: &WKNavigationAction, download: &WKDownload) {
                if let Some(wry) = self.wry(sel!(webView:navigationAction:didBecomeDownload:)) {
                    // SAFETY: as above.
                    unsafe { wry.webView_navigationAction_didBecomeDownload(webview, action, download) }
                }
            }

            #[unsafe(method(webView:navigationResponse:didBecomeDownload:))]
            fn response_download(&self, webview: &WKWebView, response: &WKNavigationResponse, download: &WKDownload) {
                if let Some(wry) = self.wry(sel!(webView:navigationResponse:didBecomeDownload:)) {
                    // SAFETY: as above.
                    unsafe { wry.webView_navigationResponse_didBecomeDownload(webview, response, download) }
                }
            }

            #[unsafe(method(webViewWebContentProcessDidTerminate:))]
            fn terminated(&self, webview: &WKWebView) {
                if let Some(wry) = self.wry(sel!(webViewWebContentProcessDidTerminate:)) {
                    // SAFETY: as above.
                    unsafe { wry.webViewWebContentProcessDidTerminate(webview) }
                }
            }
        }
    );

    impl Hook {
        fn new(mtm: MainThreadMarker, guard: Arc<Guard>, wry: &ProtocolObject<dyn WKNavigationDelegate>) -> Retained<Self> {
            let this = mtm.alloc::<Hook>().set_ivars(Ivars { guard, wry: Weak::new(wry) });
            // SAFETY: NSObject's init, on a hook whose ivars are set.
            unsafe { msg_send![super(this), init] }
        }

        /// wry's delegate, while it is there and takes `selector`.
        fn wry(&self, selector: Sel) -> Option<Retained<ProtocolObject<dyn WKNavigationDelegate>>> {
            self.ivars().wry.load().filter(|wry| wry.respondsToSelector(selector))
        }
    }

    /// The address a navigation is for, and whether it is for the page or one of its frames. A navigation with no
    /// target frame would open a new window, which counts as the page.
    ///
    /// SAFETY: `action` is a live navigation action, as WebKit hands one to the delegate.
    unsafe fn what(action: &WKNavigationAction) -> (Option<String>, Navigating) {
        // SAFETY: the caller's promise.
        let navigating = match unsafe { action.targetFrame() } {
            // SAFETY: a frame info WebKit answered.
            Some(frame) if !unsafe { frame.isMainFrame() } => Navigating::Frame,
            _ => Navigating::Page,
        };
        // SAFETY: the caller's promise.
        let request = unsafe { action.request() };
        (request.URL().and_then(|url| url.absoluteString()).map(|address| address.to_string()), navigating)
    }

    /// Where the hook is kept on its webview: the address of this byte, which nothing else uses.
    static KEY: u8 = 0;

    /// Puts a hook in front of the navigation delegate wry gave `webview`, once per webview.
    ///
    /// SAFETY: on the main thread, with `webview` a live WKWebView (Tauri's `PlatformWebview::inner`).
    pub unsafe fn install(webview: *mut c_void, guard: Arc<Guard>) {
        let (Some(mtm), false) = (MainThreadMarker::new(), webview.is_null()) else {
            return;
        };
        // SAFETY: the caller's promise.
        let view: &WKWebView = unsafe { &*(webview as *const WKWebView) };
        let key = &KEY as *const u8 as *const c_void;
        let object = webview as *mut AnyObject;
        // SAFETY: a live object, and a key only this module uses. A second hook would only stand in front of the first.
        if !unsafe { objc2::ffi::objc_getAssociatedObject(object, key) }.is_null() {
            return;
        }
        // SAFETY: on the main thread, with a live webview.
        let Some(wry) = (unsafe { view.navigationDelegate() }) else {
            return;
        };
        let hook = Hook::new(mtm, guard, &wry);
        // SAFETY: the webview keeps the hook (retained) for as long as it lives, and then names it as its delegate.
        unsafe {
            objc2::ffi::objc_setAssociatedObject(object, key, Retained::as_ptr(&hook) as *mut AnyObject,
                objc2::ffi::OBJC_ASSOCIATION_RETAIN_NONATOMIC);
            view.setNavigationDelegate(Some(ProtocolObject::from_ref(&*hook)));
        }
    }
}
