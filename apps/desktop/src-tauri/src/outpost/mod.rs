//! This Mac as one of the shop's outposts (docs/browser-control.md, "The outpost in the desktop shell"): the machine
//! that runs the team's browser for the shop's own sites, while the app is open and someone is signed in to the shop.
//! The promises it keeps: no AI ever holds a password, reading is the default, only the named members (the API checks
//! that before any grant), and nothing stops silently.
//!
//! - item.rs: the keychain item that holds this Mac's outpost and its credential, beside the API session.
//! - api.rs: the outpost's calls to the API, each from here with its own credential, never through the page.
//! - run.rs: the loop: a heartbeat every 30 seconds, steps asked for every 3, each outcome reported once.
//! - step.rs: one step in the outpost's browser: open, read, or sign in with a redeemed grant.
//! - browser.rs: that browser, a Tauri webview window of its own that reaches none of the app's commands.
//! - origin.rs: where the browser may be, and the navigation hook that keeps it there.
//!
//! The page sees only `View`: whether this Mac is the signed-in shop's outpost, online or asleep, and how many steps it
//! holds. Registering goes through the page's session (`ApiSession`, which refreshes it as every request does), but
//! the answer stops here: the credential goes into the keychain and the page gets the outpost's name.

mod api;
mod browser;
mod item;
mod origin;
mod run;
mod step;

use crate::api_link::{self, ApiAnswer, LinkError};
use item::Item;
use run::Shared;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Manager, State, WindowEvent};
use zeroize::Zeroizing;

/// Whether a command came from the outpost's window, which shows the shop's sites and never the app: lib.rs refuses
/// every command that did, whatever Tauri's own check would decide.
pub fn is_outpost_webview(label: &str) -> bool {
    label == browser::LABEL
}

/// What the Connections page shows about this Mac's outpost: never its credential, its id, or anything it read.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// `unavailable`: this computer keeps no keychain item (only macOS does), or its keychain could not be read.
    /// `unregistered`: this Mac is not the signed-in shop's outpost. `running`; `stopped`: the owner's Stop; `refused`:
    /// the API no longer takes its credential (removed, or given a new one), so it must be registered again; `idle`:
    /// registered, but not running, because nobody is signed in to that shop here.
    pub state: &'static str,
    /// Online as the API counts it: running, its last heartbeat under 90 seconds old.
    pub online: bool,
    /// How many steps it holds: handed out, and not yet reported.
    pub steps: u32,
    pub name: Option<String>,
}

impl View {
    fn bare(state: &'static str) -> View {
        View { state, online: false, steps: 0, name: None }
    }
}

enum Loaded {
    /// Not read yet: the first command reads it, off the main thread (a locked keychain asks the person first).
    Unread,
    /// This computer keeps no keychain item yet.
    Unavailable,
    Item(Option<Item>),
}

struct Inner {
    loaded: Loaded,
    /// The API's origin and the shop the page says are signed in.
    signed_in: Option<(String, String)>,
    /// The loop, while it runs.
    running: Option<Arc<Shared>>,
    refused: bool,
}

pub struct Outposts {
    app: AppHandle,
    inner: Mutex<Inner>,
    browser: Arc<browser::WebviewBrowser>,
}

/// The window's title until the page sends one in its language.
const DEFAULT_TITLE: &str = "Manut AI";

impl Outposts {
    pub fn new(app: AppHandle) -> Arc<Self> {
        let browser = Arc::new(browser::WebviewBrowser::new(app.clone(), DEFAULT_TITLE));
        Arc::new(Outposts { app, inner: Mutex::new(Inner { loaded: Loaded::Unread, signed_in: None, running: None, refused: false }), browser })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Reads the keychain's item, once it can be.
    fn load(&self) {
        if !matches!(self.lock().loaded, Loaded::Unread) {
            return;
        }
        let read = item::read();
        let mut inner = self.lock();
        if matches!(inner.loaded, Loaded::Unread) {
            match read {
                Ok(item) => inner.loaded = Loaded::Item(item),
                Err(e) if e == "unavailable" => inner.loaded = Loaded::Unavailable,
                // The person refused the keychain, or it is locked: asked again next time.
                Err(_) => {}
            }
        }
    }

    pub fn view(&self, origin: &str, tenant: &str) -> View {
        self.load();
        view_of(&self.lock(), origin, tenant)
    }

    /// Someone is signed in to `tenant` at `origin`: this Mac's outpost runs if it is that shop's and the owner has not
    /// stopped it. `title` is its window's title, in the page's language.
    pub fn signed_in(self: &Arc<Self>, origin: &str, tenant: &str, title: &str) -> View {
        self.load();
        if is_title(title) {
            self.browser.set_title(title);
        }
        let mut inner = self.lock();
        let who = (origin.to_owned(), tenant.to_owned());
        if inner.signed_in.as_ref() != Some(&who) {
            self.stop_locked(&mut inner);
        }
        inner.signed_in = Some(who);
        if !inner.refused && matches!(&inner.loaded, Loaded::Item(Some(item)) if item.is_for(origin, tenant) && !item.stopped) {
            self.start_locked(&mut inner);
        }
        view_of(&inner, origin, tenant)
    }

    /// Nobody is signed in any more: the loop stops and the window closes.
    pub fn signed_out(&self) {
        let mut inner = self.lock();
        inner.signed_in = None;
        self.stop_locked(&mut inner);
    }

    /// The app is quitting, or its main window is gone: the same as signing out, so the app can end.
    pub fn shutdown(&self) {
        self.signed_out();
    }

    /// The owner's Start (`on`) and Stop on the Connections page, for the shop signed in. Kept in the keychain's item,
    /// so a stopped outpost stays stopped when the app opens again.
    pub fn set_running(self: &Arc<Self>, origin: &str, tenant: &str, on: bool) -> Result<View, String> {
        self.load();
        let mut inner = self.lock();
        if inner.signed_in.as_ref() != Some(&(origin.to_owned(), tenant.to_owned())) {
            return Err("signed_out".into());
        }
        let Loaded::Item(Some(item)) = &mut inner.loaded else { return Err("unregistered".into()) };
        if !item.is_for(origin, tenant) {
            return Err("unregistered".into());
        }
        if item.stopped == on {
            item.stopped = !on;
            if let Err(e) = item::write(item) {
                item.stopped = on;
                return Err(e);
            }
        }
        if on {
            if !inner.refused {
                self.start_locked(&mut inner);
            }
        } else {
            self.stop_locked(&mut inner);
        }
        Ok(view_of(&inner, origin, tenant))
    }

    /// Registers this Mac through the page's session: `url` is exactly the API's `POST /v1/outposts/register`, `bearer`
    /// the session the page holds, `body` `{ name, kind: "this_mac" }`. The answer's credential goes into the keychain
    /// and nowhere else; the page gets the status, and on success the shop and the outpost's name, or a refusal's code.
    pub fn register(self: &Arc<Self>, url: &str, bearer: &str, body: &str) -> Result<ApiAnswer, String> {
        let origin = registration_origin(url).ok_or("failed")?;
        registration_name(body).ok_or("failed")?;
        let (status, answer) = api_link::request_sealed(url, "POST", Some(bearer), Some(body)).map_err(LinkError::wire)?;
        if status != 200 {
            return Ok(ApiAnswer { status, body: refusal_of(&answer) });
        }
        let item = registered(&origin, &answer).ok_or("failed")?;
        item::write(&item)?;
        let page = serde_json::json!({ "tenant": item.tenant, "outpost": { "name": item.name } }).to_string();
        let mut inner = self.lock();
        self.stop_locked(&mut inner);
        let runs = inner.signed_in.as_ref().is_some_and(|(o, t)| item.is_for(o, t));
        inner.loaded = Loaded::Item(Some(item));
        inner.refused = false;
        if runs {
            self.start_locked(&mut inner);
        }
        Ok(ApiAnswer { status: 200, body: page })
    }

    fn start_locked(self: &Arc<Self>, inner: &mut Inner) {
        if inner.running.is_some() {
            return;
        }
        let Loaded::Item(Some(item)) = &inner.loaded else { return };
        let api = api::HttpApi::new(&item.origin, &item.tenant, &item.outpost_id, &item.credential);
        let shared = Arc::new(Shared::default());
        let (me, mine, browser) = (self.clone(), shared.clone(), self.browser.clone());
        let spawned = std::thread::Builder::new().name("manut-outpost".into()).spawn(move || {
            run::run(&api, &*browser, &mine, &run::TIMING, &step::PACE);
            me.ended(&mine);
        });
        if spawned.is_ok() {
            inner.running = Some(shared);
        }
    }

    /// The loop ended. If it is still this Mac's loop, it ended by itself, because the API refused its credential: the
    /// page says so. The window closes unless a newer loop has started since.
    fn ended(&self, shared: &Arc<Shared>) {
        let mut inner = self.lock();
        let current = inner.running.as_ref().is_some_and(|running| Arc::ptr_eq(running, shared));
        if current {
            inner.running = None;
            inner.refused = shared.refused();
        }
        if inner.running.is_none() {
            browser::close(&self.app);
        }
    }

    fn stop_locked(&self, inner: &mut Inner) {
        if let Some(shared) = inner.running.take() {
            shared.stop();
        }
        browser::close(&self.app);
    }
}

fn view_of(inner: &Inner, origin: &str, tenant: &str) -> View {
    match &inner.loaded {
        Loaded::Unread | Loaded::Unavailable => View::bare("unavailable"),
        Loaded::Item(Some(item)) if item.is_for(origin, tenant) => {
            let running = inner.running.as_ref();
            let state = if inner.refused {
                "refused"
            } else if item.stopped {
                "stopped"
            } else if running.is_some() {
                "running"
            } else {
                "idle"
            };
            View { state, online: running.is_some_and(|s| s.online()), steps: running.map_or(0, |s| s.held()), name: Some(item.name.clone()) }
        }
        Loaded::Item(_) => View::bare("unregistered"),
    }
}

fn is_title(title: &str) -> bool {
    !title.trim().is_empty() && title.chars().count() <= 80 && !title.chars().any(char::is_control)
}

/// The API's origin, from an address that is exactly its route for registering this Mac.
fn registration_origin(url: &str) -> Option<String> {
    api_link::checked_url(url).ok()?;
    let origin = url.strip_suffix("/v1/outposts/register")?;
    item::is_origin(origin).then(|| origin.to_owned())
}

/// The name in a registration's body, which must be `{ name, kind: "this_mac" }` and nothing else.
fn registration_name(body: &str) -> Option<String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Wire {
        name: String,
        kind: String,
    }
    let wire: Wire = serde_json::from_str(body).ok()?;
    (wire.kind == "this_mac" && is_title(&wire.name)).then_some(wire.name)
}

/// A refusal's code, and nothing else of what the API said.
fn refusal_of(answer: &str) -> String {
    let error = serde_json::from_str::<serde_json::Value>(answer).ok().and_then(|v| v.get("error")?.as_str().map(str::to_owned));
    match error {
        Some(error) => serde_json::json!({ "error": error }).to_string(),
        None => "{}".into(),
    }
}

/// This Mac's outpost from the API's answer to its registration (`{ tenant, outpost, credential }`).
fn registered(origin: &str, answer: &str) -> Option<Item> {
    #[derive(Deserialize)]
    struct Outpost {
        id: String,
        name: String,
    }
    #[derive(Deserialize)]
    struct Wire {
        tenant: String,
        outpost: Outpost,
        credential: String,
    }
    let mut wire: Wire = serde_json::from_str(answer).ok()?;
    let credential = Zeroizing::new(std::mem::take(&mut wire.credential));
    let ok = item::is_credential(&credential) && item::is_outpost_id(&wire.outpost.id) && is_title(&wire.outpost.name) &&
        !wire.tenant.trim().is_empty() && wire.tenant.len() <= 256;
    ok.then(|| Item { origin: origin.to_owned(), tenant: wire.tenant, outpost_id: wire.outpost.id, name: wire.outpost.name, credential,
        stopped: false })
}

/// The main window is gone (a close that quits): the outpost stops and its window closes, so the app can end.
pub fn window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() == "main" && matches!(event, WindowEvent::Destroyed) {
        if let Some(outposts) = window.app_handle().try_state::<Arc<Outposts>>() {
            outposts.shutdown();
        }
    }
}

/// Quitting: the outpost stops and its window closes.
pub fn shutdown(app: &AppHandle) {
    if let Some(outposts) = app.try_state::<Arc<Outposts>>() {
        outposts.shutdown();
    }
}

// ---- the page's commands --------------------------------------------------------------------------------------------
// Each runs off the main thread: the keychain may ask the person, and a registration waits on the API.

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|_| "failed".to_string())
}

/// This Mac's outpost, for the shop the page is signed in to.
#[tauri::command]
pub async fn outpost_status(outposts: State<'_, Arc<Outposts>>, origin: String, tenant: String) -> Result<View, String> {
    let outposts = outposts.inner().clone();
    blocking(move || outposts.view(&origin, &tenant)).await
}

/// The page signed in to `tenant` at `origin` (at the app's start too): this Mac's outpost runs if it is that shop's.
#[tauri::command]
pub async fn outpost_signed_in(outposts: State<'_, Arc<Outposts>>, origin: String, tenant: String, title: String) -> Result<View, String> {
    let outposts = outposts.inner().clone();
    blocking(move || outposts.signed_in(&origin, &tenant, &title)).await
}

/// The page signed out, or its session ended: the outpost stops.
#[tauri::command]
pub async fn outpost_signed_out(outposts: State<'_, Arc<Outposts>>) -> Result<(), String> {
    let outposts = outposts.inner().clone();
    blocking(move || outposts.signed_out()).await
}

/// The owner's Start and Stop.
#[tauri::command]
pub async fn outpost_run(outposts: State<'_, Arc<Outposts>>, origin: String, tenant: String, on: bool) -> Result<View, String> {
    let outposts = outposts.inner().clone();
    blocking(move || outposts.set_running(&origin, &tenant, on)).await?
}

/// Registers this Mac with the page's session; the credential stays here.
#[tauri::command]
pub async fn outpost_register(outposts: State<'_, Arc<Outposts>>, url: String, bearer: String, body: String) -> Result<ApiAnswer, String> {
    let outposts = outposts.inner().clone();
    let bearer = Zeroizing::new(bearer);
    blocking(move || outposts.register(&url, &bearer, &body)).await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outpost::api::HttpApi;
    use crate::outpost::run::tests::{FAST, QUICK};
    use crate::outpost::step::fake::FakeBrowser;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    /// Tauri's window patterns are globs; `*` and `?` are matched here, and any other glob character is taken to
    /// match, so a pattern this cannot read never passes for one that names nothing.
    fn glob_matches(pattern: &str, label: &str) -> bool {
        if pattern.contains(['[', ']', '{', '}', '\\']) {
            return true;
        }
        fn go(p: &[char], l: &[char]) -> bool {
            match (p.first(), l.first()) {
                (None, None) => true,
                (Some('*'), _) => go(&p[1..], l) || (!l.is_empty() && go(p, &l[1..])),
                (Some('?'), Some(_)) => go(&p[1..], &l[1..]),
                (Some(a), Some(b)) if a == b => go(&p[1..], &l[1..]),
                _ => false,
            }
        }
        go(&pattern.chars().collect::<Vec<_>>(), &label.chars().collect::<Vec<_>>())
    }

    fn names_the_outpost(capability: &serde_json::Value) -> bool {
        ["windows", "webviews"].iter().any(|key| {
            capability[key].as_array().is_some_and(|patterns| {
                patterns.iter().any(|p| p.as_str().is_none_or(|p| glob_matches(p, browser::LABEL)))
            })
        })
    }

    #[test]
    fn no_capability_names_the_outposts_window_or_any_remote_page() {
        assert!(glob_matches("*", "outpost") && glob_matches("out*", "outpost") && glob_matches("outpos?", "outpost"));
        assert!(!glob_matches("main", "outpost") && !glob_matches("main*", "outpost") && glob_matches("[o]utpost", "x"));
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut read = 0;
        for entry in std::fs::read_dir(root.join("capabilities")).unwrap() {
            let path = entry.unwrap().path();
            let text = std::fs::read_to_string(&path).unwrap();
            // Only JSON capabilities are kept here; a file of another kind would go unread, so it is refused.
            assert_eq!(path.extension().and_then(|e| e.to_str()), Some("json"), "{path:?}");
            let capability: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert!(!names_the_outpost(&capability), "{path:?} names the outpost's window");
            assert!(capability.get("remote").is_none(), "{path:?} lets remote pages reach the app");
            read += 1;
        }
        assert!(read > 0);
        // Capabilities written into tauri.conf.json itself are held to the same.
        let config: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("tauri.conf.json")).unwrap()).unwrap();
        for capability in config["app"]["security"]["capabilities"].as_array().into_iter().flatten() {
            assert!(capability.is_string() || (!names_the_outpost(capability) && capability.get("remote").is_none()), "{capability}");
        }
        assert!(is_outpost_webview("outpost") && !is_outpost_webview("main"));
    }

    #[test]
    fn registers_only_through_the_apis_own_route_with_a_name_and_this_mac() {
        assert_eq!(registration_origin("https://dev.manut.xyz/v1/outposts/register").as_deref(), Some("https://dev.manut.xyz"));
        assert_eq!(registration_origin("http://localhost:8787/v1/outposts/register").as_deref(), Some("http://localhost:8787"));
        for bad in ["https://dev.manut.xyz/v1/outposts/heartbeat", "https://dev.manut.xyz/v1/outposts/register?x=1",
            "https://dev.manut.xyz/x/v1/outposts/register", "http://dev.manut.xyz/v1/outposts/register", "https://dev.manut.xyz/v1/admin/outposts"] {
            assert_eq!(registration_origin(bad), None, "{bad}");
        }
        assert_eq!(registration_name(r#"{"name":"This Mac","kind":"this_mac"}"#).as_deref(), Some("This Mac"));
        for bad in [r#"{"name":"This Mac","kind":"cloud"}"#, r#"{"name":"This Mac","kind":"this_mac","tenant":"pilot:x"}"#,
            r#"{"name":"","kind":"this_mac"}"#, r#"{"kind":"this_mac"}"#, "[]", ""] {
            assert_eq!(registration_name(bad), None, "{bad}");
        }
    }

    #[test]
    fn keeps_the_credential_from_a_registration_and_gives_the_page_only_a_refusals_code() {
        let credential = format!("mo1_{}", "Zz_-9".repeat(8) + "abc");
        let answer = serde_json::json!({ "tenant": "pilot:shop-1", "outpost": { "id": "0c7d6a4e-8f1b-4e2a-9c3d-5b6a7f8e9d0c",
            "name": "This Mac", "kind": "this_mac", "status": "asleep", "lastHeartbeatAt": null, "createdAt": "x" },
            "credential": credential }).to_string();
        let item = registered("https://dev.manut.xyz", &answer).expect("read");
        assert_eq!((item.tenant.as_str(), item.name.as_str(), item.credential.as_str(), item.stopped), ("pilot:shop-1", "This Mac",
            credential.as_str(), false));
        assert!(registered("https://dev.manut.xyz", &answer.replace("mo1_", "mo9_")).is_none());
        assert!(registered("https://dev.manut.xyz", r#"{"tenant":"t","outpost":{"id":"x y","name":"n"},"credential":"c"}"#).is_none());
        assert_eq!(refusal_of(r#"{"error":"owner_only","detail":"mo1_secret"}"#), r#"{"error":"owner_only"}"#);
        assert_eq!(refusal_of("not json"), "{}");
    }

    fn sample(stopped: bool) -> Item {
        Item { origin: "https://dev.manut.xyz".into(), tenant: "pilot:shop-1".into(), outpost_id: "op-1".into(), name: "This Mac".into(),
            credential: Zeroizing::new(format!("mo1_{}", "a".repeat(43))), stopped }
    }

    #[test]
    fn shows_the_page_where_this_macs_outpost_stands_and_nothing_secret() {
        let inner = |loaded, running: Option<Arc<Shared>>, refused| Inner { loaded, signed_in: None, running, refused };
        let (origin, shop) = ("https://dev.manut.xyz", "pilot:shop-1");
        assert_eq!(view_of(&inner(Loaded::Unavailable, None, false), origin, shop).state, "unavailable");
        assert_eq!(view_of(&inner(Loaded::Item(None), None, false), origin, shop).state, "unregistered");
        assert_eq!(view_of(&inner(Loaded::Item(Some(sample(false))), None, false), origin, "pilot:another").state, "unregistered");
        assert_eq!(view_of(&inner(Loaded::Item(Some(sample(false))), None, false), "http://localhost:8787", shop).state, "unregistered");
        assert_eq!(view_of(&inner(Loaded::Item(Some(sample(false))), None, false), origin, shop),
            View { state: "idle", online: false, steps: 0, name: Some("This Mac".into()) });
        assert_eq!(view_of(&inner(Loaded::Item(Some(sample(true))), None, false), origin, shop).state, "stopped");
        assert_eq!(view_of(&inner(Loaded::Item(Some(sample(false))), Some(Arc::new(Shared::default())), false), origin, shop).state, "running");
        assert_eq!(view_of(&inner(Loaded::Item(Some(sample(false))), None, true), origin, shop).state, "refused");
        let shown = serde_json::to_string(&view_of(&inner(Loaded::Item(Some(sample(false))), None, false), origin, shop)).unwrap();
        assert_eq!(shown, r#"{"state":"idle","online":false,"steps":0,"name":"This Mac"}"#);
    }

    /// A stand-in for the API on this computer: it answers each request with what `answer` says for its path and body,
    /// and keeps every request it was sent, whole, until it is dropped.
    struct FakeApi {
        origin: String,
        seen: Arc<Mutex<Vec<String>>>,
        done: Arc<AtomicBool>,
    }

    impl Drop for FakeApi {
        fn drop(&mut self) {
            self.done.store(true, Ordering::SeqCst);
        }
    }

    fn fake_api(answer: impl Fn(&str, &str) -> (u16, String) + Send + 'static) -> FakeApi {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let done = Arc::new(AtomicBool::new(false));
        let (kept, over) = (seen.clone(), done.clone());
        std::thread::spawn(move || {
            while !over.load(Ordering::SeqCst) {
                let Ok((mut stream, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                };
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut request = Vec::new();
                let mut buf = [0u8; 4096];
                let (head, body) = loop {
                    let n = stream.read(&mut buf).unwrap_or(0);
                    if n == 0 {
                        break (String::new(), String::new());
                    }
                    request.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&request).to_string();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text[..end].lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break (text[..end].to_owned(), text[end + 4..].to_owned());
                        }
                    }
                };
                let path = head.split_whitespace().nth(1).unwrap_or("").to_owned();
                kept.lock().unwrap().push(format!("{head}\r\n\r\n{body}"));
                let (status, reply) = answer(&path, &body);
                let _ = stream.write_all(format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                    reply.len()).as_bytes());
            }
        });
        FakeApi { origin, seen, done }
    }

    const SHOP: &str = "https://seller.shopee.co.th";
    const ACCOUNTS: &str = "https://accounts.shopee.co.th";

    #[test]
    fn a_known_password_reaches_the_page_and_nothing_the_outpost_reports_shows_or_logs() {
        let password = "Kn0wn \"pass\\word\" é🔑";
        let username = "fon@baanmali.example";
        let credential = format!("mo1_{}", "Q".repeat(43));
        let asks = Arc::new(Mutex::new(0));
        let counted = asks.clone();
        let api = fake_api(move |path, _| match path {
            "/v1/outposts/heartbeat" => (200, r#"{"outpost":{"status":"online"}}"#.into()),
            "/v1/outposts/steps" => {
                let mut asks = counted.lock().unwrap();
                *asks += 1;
                let steps = if *asks == 1 {
                    serde_json::json!([{ "stepId": "s-1", "kind": "sign_in", "grantId": "g-1", "origins": [ACCOUNTS, SHOP],
                        "expiresAt": "x" }])
                } else {
                    serde_json::json!([])
                };
                (200, serde_json::json!({ "steps": steps }).to_string())
            }
            "/v1/outposts/redeem" => (200, serde_json::json!({ "signInId": "si-1", "site": "Shopee Seller Centre",
                "origins": [ACCOUNTS], "username": username, "password": password }).to_string()),
            "/v1/outposts/steps/report" => (200, r#"{"step":{"stepId":"s-1","state":"done"}}"#.into()),
            _ => (404, r#"{"error":"not_found"}"#.into()),
        });
        let http = HttpApi::new(&api.origin, "pilot:shop-1", "op-1", &credential);
        let browser = FakeBrowser::at(Some(&format!("{ACCOUNTS}/seller/login")), Box::new(|name, _| match name {
            "form" => Ok(format!(r#"{{"f":true,"a":"{ACCOUNTS}/seller/login"}}"#)),
            "type" => Ok(r#"{"r":"typed"}"#.into()),
            "check" => Ok(r#"{"s":"in"}"#.into()),
            _ => Ok(r#"{"t":""}"#.into()),
        }));
        let shared = Shared::default();
        std::thread::scope(|scope| {
            let handle = scope.spawn(|| run::run(&http, &browser, &shared, &FAST, &QUICK));
            let started = Instant::now();
            while !api.seen.lock().unwrap().iter().any(|r| r.starts_with("POST /v1/outposts/steps/report"))
                && started.elapsed() < Duration::from_secs(10) {
                std::thread::sleep(Duration::from_millis(5));
            }
            shared.stop();
            handle.join().unwrap();
        });

        let seen = api.seen.lock().unwrap().clone();
        let reports: Vec<&String> = seen.iter().filter(|r| r.starts_with("POST /v1/outposts/steps/report")).collect();
        assert_eq!(reports.len(), 1, "reported once");
        let report: serde_json::Value = serde_json::from_str(reports[0].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(report, serde_json::json!({ "tenant": "pilot:shop-1", "outpostId": "op-1", "stepId": "s-1", "outcome": "done" }));
        assert!(seen.iter().any(|r| r.starts_with("POST /v1/outposts/redeem") && r.contains(&format!("Authorization: Bearer {credential}"))));

        // The page had it, once, from the typing script, which the browser hands over as an argument.
        let calls = browser.calls.lock().unwrap();
        let typed: Vec<_> = calls.iter().filter(|(_, args)| args.values().any(|v| v.contains(password))).collect();
        assert_eq!(typed.len(), 1);
        assert_eq!((typed[0].0, typed[0].1["p"].as_str(), typed[0].1["u"].as_str()), ("type", password, username));

        // Nothing else: no request the outpost sent, nothing it noted, nothing the page is shown.
        let escaped = serde_json::to_string(password).unwrap();
        let shown = serde_json::to_string(&View { state: "running", online: shared.online(), steps: shared.held(), name: Some("This Mac".into()) }).unwrap();
        let notes = shared.notes().join("\n");
        for (what, text) in seen.iter().map(|r| ("a request", r.as_str())).chain([("the notes", notes.as_str()), ("the view", shown.as_str())]) {
            for secret in [password, &escaped[1..escaped.len() - 1], "Kn0wn", username] {
                assert!(!text.contains(secret), "{what} holds {secret:?}: {text}");
            }
        }
    }
}
