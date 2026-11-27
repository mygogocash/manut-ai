//! The phone's second road (item 78f, docs/remote-access.md, "The second road: Tailscale"): a door on this Mac that a
//! paired phone reaches over the person's own tailnet, through `tailscale serve`, instead of through the relay. It is the
//! first listener in the shell, so it is narrow on purpose:
//!
//! - It binds to 127.0.0.1 only. Tailscale reaches it through `serve` (`tailscale_serve.rs`), which gives the Mac a real
//!   certificate under its `ts.net` name and ends TLS there; nothing on any other network can open it.
//! - It speaks the phone's side of the relay's protocol and nothing else (docs/relay-protocol-v1.md, sections 2, 4, 6 to
//!   11): the route `/relay/v1/hosts/<hostID>/phone` of this Mac's own host id, from the phone page's own origin; a `hello`
//!   with a device id and token whose SHA-256 the page registered, compared in constant time, within 10 seconds; then
//!   binary frames of at most 65,532 bytes, the `ping` keepalive, and the relay's close codes. It is the relay object made
//!   small and local: it reads no frame (each carries `@manut/remote-channel`'s sealed records, which only the page and the
//!   phone hold keys for), decides nothing, and holds no key.
//! - The page says which devices may come in (`door_devices`, the same ids and token hashes it registers with the relay),
//!   what a new phone is told about the Mac (`door_status`), and is handed each stream's `open`, frames and `close` over a
//!   Tauri channel, so `remote/link.ts`'s session code serves both roads alike.
//! - Every connection arrives from 127.0.0.1, so its limits count all connections together, never by address: at most 8
//!   that have not said `hello` yet and 8 phones.
//!
//! Pairing, the channel's key K and each ask's challenge are the same on this road as on the relay's: a tailnet holds
//! teammates' devices, shared devices and compromised ones, and TLS ends in Tailscale, not in Manut AI. Nothing here reads
//! a `Tailscale-User-Login` header as who someone is. Nothing is logged: no token, device id or frame reaches a log line
//! or an error.
use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use crate::lock::LockOrRecover;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tungstenite::{accept_hdr_with_config, Message, WebSocket};

/// The largest message on any hop, and the largest payload a phone may send (relay protocol, section 9).
pub const MAX_MESSAGE: usize = 65_536;
pub const MAX_PAYLOAD: usize = 65_532;
/// How long a socket has to say a valid `hello` after the upgrade.
pub const AUTH_WAIT: Duration = Duration::from_secs(10);
/// Sockets that have not said `hello` yet, and phones, at once. All arrive from 127.0.0.1, so these count everyone.
pub const UNAUTH_MAX: usize = 8;
pub const PHONES_MAX: usize = 8;
/// A phone that has sent nothing, not even a `ping`, for this long is closed. The phone page pings every 50 seconds.
pub const IDLE: Duration = Duration::from_secs(180);
/// How often a phone's thread stops reading to send what the page queued.
const TICK: Duration = Duration::from_millis(50);

/// Close codes (relay protocol, section 10).
pub mod close {
    pub const NORMAL: u16 = 1000;
    pub const BAD_REQUEST: u16 = 4400;
    pub const UNAUTHENTICATED: u16 = 4401;
    pub const REVOKED: u16 = 4403;
    pub const HOST_UNAVAILABLE: u16 = 4404;
    pub const REPLACED: u16 = 4409;
    pub const TOO_LARGE: u16 = 4413;
    pub const OVER_BUDGET: u16 = 4429;
}

/// What the page is handed. Implemented over a Tauri channel in the app and by a recorder in the tests.
pub trait DoorEvents: Send + Sync {
    fn open(&self, stream: u32, device: &str);
    fn frame(&self, stream: u32, payload: &[u8]);
    fn close(&self, stream: u32, reason: &str);
}

/// What the Mac tells a phone that cannot come in now (relay protocol, section 8). `Available` lets phones in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostState {
    Available,
    Paused,
    Sleeping,
    Off,
}

impl HostState {
    fn word(self) -> &'static str {
        match self {
            HostState::Available => "available",
            HostState::Paused => "paused",
            HostState::Sleeping => "sleeping",
            HostState::Off => "off",
        }
    }
}

/// One device the page lets in: its id and the SHA-256 of its 32 token bytes, both as the relay is told them.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEntry {
    pub id: String,
    pub token_hash: String,
}

enum Out {
    Frame(Vec<u8>),
    Text(String),
    Close(u16, &'static str),
}

struct Phone {
    device: String,
    tx: mpsc::Sender<Out>,
    /// The page or the door closed it on purpose: the page is not told again.
    quiet: Arc<AtomicBool>,
}

struct Inner {
    host_id: String,
    origin: String,
    devices: Mutex<HashMap<String, [u8; 32]>>,
    phones: Mutex<HashMap<u32, Phone>>,
    unauth: AtomicUsize,
    state: Mutex<(HostState, u64)>,
    events: Arc<dyn DoorEvents>,
    stop: AtomicBool,
    auth_wait: Duration,
}

/// The running door.
pub struct Door {
    inner: Arc<Inner>,
    addr: SocketAddr,
}

/// A device id as the relay takes one: a UUID in upper-case 8-4-4-4-12 form.
pub fn device_ok(id: &str) -> bool {
    let groups: Vec<&str> = id.split('-').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(g, n)| g.len() == n && g.bytes().all(|c| c.is_ascii_digit() || (b'A'..=b'F').contains(&c)))
}

/// A host id: 43 base64url characters.
pub fn host_ok(id: &str) -> bool {
    id.len() == 43 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// 32 bytes from 43 characters of base64url without padding, or None.
fn bytes32(text: &str) -> Option<[u8; 32]> {
    if text.len() != 43 {
        return None;
    }
    data_encoding::BASE64URL_NOPAD.decode(text.as_bytes()).ok()?.try_into().ok()
}

/// `a == b` in time that does not depend on where they differ.
fn same(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The device a `hello` names, when it is a readable hello (relay protocol, section 4) whose token's SHA-256 is that
/// device's registered hash.
fn hello_ok(text: &str, devices: &HashMap<String, [u8; 32]>) -> Option<String> {
    let v: Value = serde_json::from_str(text).ok()?;
    if v.get("t")?.as_str()? != "hello" || v.get("v")?.as_u64()? != 1 {
        return None;
    }
    let device = v.get("device")?.as_str()?;
    let token = bytes32(v.get("token")?.as_str()?)?;
    let want = devices.get(device)?;
    let got: [u8; 32] = Sha256::digest(token).into();
    same(&got, want).then(|| device.to_string())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn close_with(ws: &mut WebSocket<TcpStream>, code: u16, reason: &'static str) {
    let _ = ws.close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.into() }));
    // let the close frame go out and the other side answer, briefly
    let until = Instant::now() + Duration::from_millis(300);
    while Instant::now() < until {
        match ws.read() {
            Ok(_) => continue,
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => continue,
            Err(_) => break,
        }
    }
}

/// Counts a socket among those that have not said `hello` until it is dropped or `done` is called.
struct Unauth<'a>(&'a AtomicUsize, bool);
impl Unauth<'_> {
    fn done(&mut self) {
        if !self.1 {
            self.0.fetch_sub(1, Ordering::SeqCst);
            self.1 = true;
        }
    }
}
impl Drop for Unauth<'_> {
    fn drop(&mut self) {
        self.done();
    }
}

impl Door {
    /// Starts the door on `addr`, which must be a loopback address, for host `host_id`, letting in pages from `origin`.
    pub fn start(addr: SocketAddr, host_id: &str, origin: &str, events: Arc<dyn DoorEvents>) -> Result<Door, String> {
        Door::start_with(addr, host_id, origin, events, AUTH_WAIT)
    }

    pub fn start_with(addr: SocketAddr, host_id: &str, origin: &str, events: Arc<dyn DoorEvents>, auth_wait: Duration) -> Result<Door, String> {
        if !addr.ip().is_loopback() {
            return Err("the door listens on this Mac's own address only".into());
        }
        if !host_ok(host_id) {
            return Err("that is not this Mac's host id".into());
        }
        if !(origin.starts_with("https://") || origin.starts_with("http://127.0.0.1")) || origin.contains(char::is_whitespace) {
            return Err("that is not the phone page's origin".into());
        }
        let listener = TcpListener::bind(addr).map_err(|e| format!("the door could not open its port: {e}"))?;
        let addr = listener.local_addr().map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let inner = Arc::new(Inner {
            host_id: host_id.to_string(),
            origin: origin.trim_end_matches('/').to_string(),
            devices: Mutex::new(HashMap::new()),
            phones: Mutex::new(HashMap::new()),
            unauth: AtomicUsize::new(0),
            state: Mutex::new((HostState::Available, now_secs())),
            events,
            stop: AtomicBool::new(false),
            auth_wait,
        });
        let i = inner.clone();
        std::thread::Builder::new()
            .name("remote-door".into())
            .spawn(move || {
                while !i.stop.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((s, _)) => {
                            let i = i.clone();
                            let _ = std::thread::Builder::new().name("remote-door-phone".into()).spawn(move || serve(&i, s));
                        }
                        Err(e) if e.kind() == ErrorKind::WouldBlock => std::thread::sleep(TICK),
                        Err(_) => std::thread::sleep(TICK),
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Door { inner, addr })
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// The devices that may come in, as the page has them now. A phone whose device is gone, or whose token changed, is
    /// closed with 4403, as the relay closes a revoked device. Entries that cannot be read are left out.
    pub fn set_devices(&self, list: &[DeviceEntry]) {
        let next: HashMap<String, [u8; 32]> = list.iter().filter(|d| device_ok(&d.id)).filter_map(|d| Some((d.id.clone(), bytes32(&d.token_hash)?))).collect();
        let mut devices = self.inner.devices.lock_or_recover();
        for p in self.inner.phones.lock_or_recover().values() {
            let kept = next.get(&p.device);
            if kept.is_none() || kept != devices.get(&p.device) {
                let _ = p.tx.send(Out::Close(close::REVOKED, "revoked"));
            }
        }
        *devices = next;
    }

    /// What a new phone is told. `Off` also closes every phone, each after a `host` message (relay protocol, section 8).
    pub fn set_status(&self, state: HostState) {
        *self.inner.state.lock_or_recover() = (state, now_secs());
        if state == HostState::Off {
            for p in self.inner.phones.lock_or_recover().values() {
                let _ = p.tx.send(Out::Text(json!({"t": "host", "v": 1, "state": "off", "at": now_secs()}).to_string()));
                let _ = p.tx.send(Out::Close(close::HOST_UNAVAILABLE, "off"));
            }
        }
    }

    /// A frame from the page to the phone on `stream`. False when there is no such phone or the frame is too large.
    pub fn send(&self, stream: u32, payload: Vec<u8>) -> bool {
        if payload.len() > MAX_PAYLOAD {
            return false;
        }
        self.inner.phones.lock_or_recover().get(&stream).is_some_and(|p| p.tx.send(Out::Frame(payload)).is_ok())
    }

    /// The page closes `stream` (1000); it is not told again.
    pub fn close_stream(&self, stream: u32) -> bool {
        let phones = self.inner.phones.lock_or_recover();
        let Some(p) = phones.get(&stream) else { return false };
        p.quiet.store(true, Ordering::SeqCst);
        p.tx.send(Out::Close(close::NORMAL, "closed")).is_ok()
    }

    /// Closes every phone and stops listening.
    pub fn stop(&self) {
        self.inner.stop.store(true, Ordering::SeqCst);
        for p in self.inner.phones.lock_or_recover().values() {
            let _ = p.tx.send(Out::Close(close::NORMAL, "closed"));
        }
    }
}

impl Drop for Door {
    fn drop(&mut self) {
        self.stop();
    }
}

/// A random stream number no open phone has.
fn new_stream(phones: &HashMap<u32, Phone>) -> u32 {
    loop {
        let mut b = [0u8; 4];
        if getrandom_fill(&mut b) {
            let n = u32::from_be_bytes(b);
            if !phones.contains_key(&n) {
                return n;
            }
        }
    }
}

/// Fills `b` from the system's random source.
fn getrandom_fill(b: &mut [u8]) -> bool {
    use std::io::Read;
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(b)).is_ok()
}

/// One connection, from the upgrade to its close.
fn serve(inner: &Arc<Inner>, tcp: TcpStream) {
    if inner.unauth.fetch_add(1, Ordering::SeqCst) >= UNAUTH_MAX {
        inner.unauth.fetch_sub(1, Ordering::SeqCst);
        return;
    }
    let mut unauth = Unauth(&inner.unauth, false);
    let _ = tcp.set_nonblocking(false);
    let _ = tcp.set_nodelay(true);
    let _ = tcp.set_read_timeout(Some(inner.auth_wait));
    let _ = tcp.set_write_timeout(Some(Duration::from_secs(10)));
    let route = format!("/relay/v1/hosts/{}/phone", inner.host_id);
    let origin = inner.origin.clone();
    let check = move |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        let refuse = |status: u16| {
            let mut r = ErrorResponse::new(None);
            *r.status_mut() = tungstenite::http::StatusCode::from_u16(status).unwrap_or(tungstenite::http::StatusCode::FORBIDDEN);
            r
        };
        if req.uri().path() != route || req.uri().query().is_some() {
            return Err(refuse(404));
        }
        // a page of any other site, which a browser lets open a socket here, is refused before a hello is read
        if req.headers().get("origin").and_then(|o| o.to_str().ok()) != Some(origin.as_str()) {
            return Err(refuse(403));
        }
        Ok(resp)
    };
    let config = WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE)).max_frame_size(Some(MAX_MESSAGE));
    let Ok(mut ws) = accept_hdr_with_config(tcp, check, Some(config)) else { return };

    // the hello, within the wait; the `ping` keepalive may come first and is answered
    let started = Instant::now();
    let device = loop {
        if started.elapsed() >= inner.auth_wait {
            return close_with(&mut ws, close::UNAUTHENTICATED, "unauthenticated");
        }
        match ws.read() {
            Ok(Message::Text(t)) if t.as_str() == "ping" => {
                let _ = ws.send(Message::Text("pong".into()));
            }
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
            Ok(Message::Text(t)) => match hello_ok(t.as_str(), &inner.devices.lock_or_recover()) {
                Some(d) => break d,
                None => return close_with(&mut ws, close::UNAUTHENTICATED, "unauthenticated"),
            },
            Ok(_) => return close_with(&mut ws, close::UNAUTHENTICATED, "unauthenticated"),
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                return close_with(&mut ws, close::UNAUTHENTICATED, "unauthenticated");
            }
            Err(_) => return,
        }
    };

    // the Mac takes phones only while available; otherwise the phone is told why, as the relay tells it
    let (state, at) = *inner.state.lock_or_recover();
    if state != HostState::Available {
        let _ = ws.send(Message::Text(json!({"t": "host", "v": 1, "state": state.word(), "at": at}).to_string().into()));
        return close_with(&mut ws, close::HOST_UNAVAILABLE, "host_unavailable");
    }

    // one socket a device: a newer hello replaces the older socket, and the page hears the old stream close first
    let (tx, rx) = mpsc::channel::<Out>();
    let quiet = Arc::new(AtomicBool::new(false));
    let stream = {
        let mut phones = inner.phones.lock_or_recover();
        let old: Vec<u32> = phones.iter().filter(|(_, p)| p.device == device).map(|(s, _)| *s).collect();
        for s in old {
            if let Some(p) = phones.remove(&s) {
                p.quiet.store(true, Ordering::SeqCst);
                let _ = p.tx.send(Out::Close(close::REPLACED, "replaced"));
                inner.events.close(s, "replaced");
            }
        }
        if phones.len() >= PHONES_MAX {
            drop(phones);
            return close_with(&mut ws, close::OVER_BUDGET, "over_budget");
        }
        let s = new_stream(&phones);
        phones.insert(s, Phone { device: device.clone(), tx, quiet: quiet.clone() });
        s
    };
    unauth.done();
    inner.events.open(stream, &device);
    if ws.send(Message::Text(json!({"t": "ready", "v": 1}).to_string().into())).is_err() {
        return finish(inner, stream, &quiet, "closed");
    }
    let _ = ws.get_mut().set_read_timeout(Some(TICK));

    let mut seen = Instant::now();
    let reason = loop {
        match ws.read() {
            Ok(Message::Binary(b)) => {
                seen = Instant::now();
                if b.len() > MAX_PAYLOAD {
                    close_with(&mut ws, close::TOO_LARGE, "too_large");
                    break "too_large";
                }
                inner.events.frame(stream, &b);
            }
            Ok(Message::Text(t)) if t.as_str() == "ping" => {
                seen = Instant::now();
                let _ = ws.send(Message::Text("pong".into()));
            }
            Ok(Message::Text(_)) => {
                close_with(&mut ws, close::BAD_REQUEST, "bad_request");
                break "bad_request";
            }
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) | Ok(Message::Frame(_)) => seen = Instant::now(),
            Ok(Message::Close(_)) => break "closed",
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(tungstenite::Error::Capacity(_)) => {
                close_with(&mut ws, close::TOO_LARGE, "too_large");
                break "too_large";
            }
            Err(_) => break "closed",
        }
        let mut closing = None;
        while let Ok(out) = rx.try_recv() {
            match out {
                Out::Frame(f) => {
                    let _ = ws.send(Message::Binary(f.into()));
                }
                Out::Text(t) => {
                    let _ = ws.send(Message::Text(t.into()));
                }
                Out::Close(code, why) => {
                    closing = Some((code, why));
                    break;
                }
            }
        }
        let _ = ws.flush();
        if let Some((code, why)) = closing {
            close_with(&mut ws, code, why);
            break why;
        }
        if seen.elapsed() >= IDLE {
            close_with(&mut ws, close::NORMAL, "idle");
            break "idle";
        }
    };
    finish(inner, stream, &quiet, reason);
}

/// The phone on `stream` is gone: it leaves the door, and the page hears it unless the page or a newer socket closed it.
fn finish(inner: &Arc<Inner>, stream: u32, quiet: &AtomicBool, reason: &str) {
    let mut phones = inner.phones.lock_or_recover();
    let ours = phones.get(&stream).is_some_and(|p| std::ptr::eq(p.quiet.as_ref(), quiet));
    if ours {
        phones.remove(&stream);
    }
    drop(phones);
    if !quiet.load(Ordering::SeqCst) {
        inner.events.close(stream, reason);
    }
}

// ---- the app's door ---------------------------------------------------------------------------------------------------

/// The page's channel: `{"t":"open","stream","device"}`, `{"t":"frame","stream","data"}` (the payload in standard base64)
/// and `{"t":"close","stream","reason"}`.
struct ChannelEvents(tauri::ipc::Channel<Value>);

impl DoorEvents for ChannelEvents {
    fn open(&self, stream: u32, device: &str) {
        let _ = self.0.send(json!({"t": "open", "stream": stream, "device": device}));
    }
    fn frame(&self, stream: u32, payload: &[u8]) {
        let _ = self.0.send(json!({"t": "frame", "stream": stream, "data": crate::computer::hub::base64(payload)}));
    }
    fn close(&self, stream: u32, reason: &str) {
        let _ = self.0.send(json!({"t": "close", "stream": stream, "reason": reason}));
    }
}

static DOOR: Mutex<Option<Door>> = Mutex::new(None);

/// What turning the road on gives the page: the Mac's name on the tailnet and the door's port, for the pairing code.
#[derive(serde::Serialize)]
pub struct DoorOn {
    pub name: String,
    pub port: u16,
}

/// Settings, Sharing and access, the Tailscale road switched on: only when Tailscale says this Mac is ready (HTTPS
/// certificates on), the door starts on 127.0.0.1 and Tailscale serves it on the door's one port. If serving fails, the
/// door stops again, so a door is never left listening with no road to it.
#[tauri::command]
pub async fn tailscale_door_on(host_id: String, origin: String, on_event: tauri::ipc::Channel<Value>) -> Result<DoorOn, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let crate::tailscale::Tailscale::Ready { name } = crate::tailscale::read() else {
            return Err("Tailscale is not ready on this Mac".to_string());
        };
        let port = crate::tailscale_serve::DOOR_PORT;
        let mut slot = DOOR.lock_or_recover();
        if let Some(old) = slot.take() {
            old.stop();
        }
        let door = Door::start(SocketAddr::from(([127, 0, 0, 1], port)), &host_id, &origin, Arc::new(ChannelEvents(on_event)))?;
        // Tailscale will serve exactly this port: the door must be on it, never on one the system picked instead
        if door.addr().port() != port {
            door.stop();
            return Err("the door is not on its own port".to_string());
        }
        if let Err(e) = crate::tailscale_serve::serve_on(port) {
            door.stop();
            return Err(e);
        }
        *slot = Some(door);
        Ok(DoorOn { name, port })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The Tailscale road switched off: Tailscale stops serving the door's port (only that entry), and the door closes every
/// phone and stops listening.
#[tauri::command]
pub async fn tailscale_door_off() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let served = crate::tailscale_serve::serve_off(crate::tailscale_serve::DOOR_PORT);
        if let Some(door) = DOOR.lock_or_recover().take() {
            door.stop();
        }
        served
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn door_devices(devices: Vec<DeviceEntry>) -> bool {
    DOOR.lock_or_recover().as_ref().map(|d| d.set_devices(&devices)).is_some()
}

#[tauri::command]
pub fn door_status(state: HostState) -> bool {
    DOOR.lock_or_recover().as_ref().map(|d| d.set_status(state)).is_some()
}

/// A frame for the phone on `stream`, its payload in standard base64.
#[tauri::command]
pub fn door_send(stream: u32, data: String) -> bool {
    let Ok(payload) = data_encoding::BASE64.decode(data.as_bytes()) else { return false };
    DOOR.lock_or_recover().as_ref().is_some_and(|d| d.send(stream, payload))
}

#[tauri::command]
pub fn door_close(stream: u32) -> bool {
    DOOR.lock_or_recover().as_ref().is_some_and(|d| d.close_stream(stream))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tungstenite::client::IntoClientRequest;

    const HOST: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const ORIGIN: &str = "https://dev.manut.xyz";
    const DEVICE: &str = "E621E1F8-C36C-495A-93FC-0C247A3E6E5F";
    const OTHER: &str = "11111111-2222-3333-4444-555555555555";

    #[derive(Default)]
    struct Heard(Mutex<Vec<String>>);
    impl DoorEvents for Heard {
        fn open(&self, stream: u32, device: &str) {
            self.0.lock().unwrap().push(format!("open {stream} {device}"));
        }
        fn frame(&self, stream: u32, payload: &[u8]) {
            self.0.lock().unwrap().push(format!("frame {stream} {}", String::from_utf8_lossy(payload)));
        }
        fn close(&self, stream: u32, reason: &str) {
            self.0.lock().unwrap().push(format!("close {stream} {reason}"));
        }
    }
    impl Heard {
        fn all(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }
        fn wait(&self, n: usize) -> Vec<String> {
            for _ in 0..200 {
                if self.all().len() >= n {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            self.all()
        }
    }

    fn token(n: u8) -> ([u8; 32], String, String) {
        let t = [n; 32];
        let hash: [u8; 32] = Sha256::digest(t).into();
        (t, data_encoding::BASE64URL_NOPAD.encode(&t), data_encoding::BASE64URL_NOPAD.encode(&hash))
    }

    fn door(heard: &Arc<Heard>, wait: Duration) -> Door {
        let d = Door::start_with(SocketAddr::from(([127, 0, 0, 1], 0)), HOST, ORIGIN, heard.clone(), wait).unwrap();
        let (_, _, h1) = token(1);
        let (_, _, h2) = token(2);
        d.set_devices(&[DeviceEntry { id: DEVICE.into(), token_hash: h1 }, DeviceEntry { id: OTHER.into(), token_hash: h2 }]);
        d
    }

    type Client = WebSocket<TcpStream>;

    fn dial(d: &Door, path: &str, origin: Option<&str>) -> Result<Client, String> {
        let mut req = format!("ws://{}{path}", d.addr()).into_client_request().unwrap();
        if let Some(o) = origin {
            req.headers_mut().insert("Origin", o.parse().unwrap());
        }
        let tcp = TcpStream::connect(d.addr()).map_err(|e| e.to_string())?;
        tcp.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        tungstenite::client(req, tcp).map(|(ws, _)| ws).map_err(|e| e.to_string())
    }

    fn route() -> String {
        format!("/relay/v1/hosts/{HOST}/phone")
    }

    fn hello(ws: &mut Client, device: &str, tok: &str) {
        ws.send(Message::Text(json!({"t": "hello", "v": 1, "device": device, "token": tok}).to_string().into())).unwrap();
    }

    /// What the phone reads next: a text, a binary as text, or the close code.
    fn next(ws: &mut Client) -> String {
        loop {
            match ws.read() {
                Ok(Message::Text(t)) => return t.as_str().to_string(),
                Ok(Message::Binary(b)) => return format!("bin {}", String::from_utf8_lossy(&b)),
                Ok(Message::Close(Some(f))) => return format!("close {}", u16::from(f.code)),
                Ok(Message::Close(None)) => return "close".into(),
                Ok(_) => continue,
                Err(e) => return format!("gone {e}"),
            }
        }
    }

    #[test]
    fn it_listens_on_this_macs_own_address_only() {
        let heard = Arc::new(Heard::default());
        assert!(Door::start(SocketAddr::from(([0, 0, 0, 0], 0)), HOST, ORIGIN, heard.clone()).is_err());
        assert!(Door::start(SocketAddr::from(([192, 168, 1, 2], 0)), HOST, ORIGIN, heard.clone()).is_err());
        assert!(Door::start(SocketAddr::from(([127, 0, 0, 1], 0)), "short", ORIGIN, heard.clone()).is_err());
        let d = door(&heard, AUTH_WAIT);
        assert!(d.addr().ip().is_loopback());
    }

    #[test]
    fn only_this_macs_route_from_the_phone_pages_origin_is_upgraded() {
        let heard = Arc::new(Heard::default());
        let d = door(&heard, AUTH_WAIT);
        assert!(dial(&d, "/relay/v1/hosts/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/phone", Some(ORIGIN)).unwrap_err().contains("404"));
        assert!(dial(&d, "/relay/v1/hosts/x/socket", Some(ORIGIN)).unwrap_err().contains("404"));
        assert!(dial(&d, &format!("{}?a=1", route()), Some(ORIGIN)).unwrap_err().contains("404"));
        assert!(dial(&d, &route(), Some("https://evil.example")).unwrap_err().contains("403"));
        assert!(dial(&d, &route(), None).unwrap_err().contains("403"));
        assert!(dial(&d, &route(), Some(ORIGIN)).is_ok());
        assert!(heard.all().is_empty());
    }

    #[test]
    fn a_wrong_token_an_unknown_device_or_no_hello_in_time_is_4401_and_the_page_hears_nothing() {
        let heard = Arc::new(Heard::default());
        let d = door(&heard, Duration::from_millis(300));
        let (_, t2, _) = token(2);
        let mut ws = dial(&d, &route(), Some(ORIGIN)).unwrap();
        hello(&mut ws, DEVICE, &t2);
        assert_eq!(next(&mut ws), "close 4401");
        let (_, t1, _) = token(1);
        let mut ws = dial(&d, &route(), Some(ORIGIN)).unwrap();
        hello(&mut ws, "AAAAAAAA-0000-0000-0000-000000000000", &t1);
        assert_eq!(next(&mut ws), "close 4401");
        let mut ws = dial(&d, &route(), Some(ORIGIN)).unwrap();
        ws.send(Message::Text("not json".into())).unwrap();
        assert_eq!(next(&mut ws), "close 4401");
        let mut ws = dial(&d, &route(), Some(ORIGIN)).unwrap();
        ws.send(Message::Binary(vec![1, 2].into())).unwrap();
        assert_eq!(next(&mut ws), "close 4401");
        // the keepalive is answered, but it is not a hello, and the wait still runs out
        let mut ws = dial(&d, &route(), Some(ORIGIN)).unwrap();
        ws.send(Message::Text("ping".into())).unwrap();
        assert_eq!(next(&mut ws), "pong");
        assert_eq!(next(&mut ws), "close 4401");
        assert!(heard.all().is_empty());
    }

    #[test]
    fn a_known_phone_gets_a_stream_and_frames_go_both_ways_unread() {
        let heard = Arc::new(Heard::default());
        let d = door(&heard, AUTH_WAIT);
        let (_, t1, _) = token(1);
        let mut ws = dial(&d, &route(), Some(ORIGIN)).unwrap();
        hello(&mut ws, DEVICE, &t1);
        assert_eq!(next(&mut ws), r#"{"t":"ready","v":1}"#);
        let opened = heard.wait(1);
        let stream: u32 = opened[0].split(' ').nth(1).unwrap().parse().unwrap();
        assert_eq!(opened[0], format!("open {stream} {DEVICE}"));
        ws.send(Message::Binary(b"sealed record".to_vec().into())).unwrap();
        assert_eq!(heard.wait(2)[1], format!("frame {stream} sealed record"));
        assert!(d.send(stream, b"from the mac".to_vec()));
        assert_eq!(next(&mut ws), "bin from the mac");
        ws.send(Message::Text("ping".into())).unwrap();
        assert_eq!(next(&mut ws), "pong");
        assert!(!d.send(stream, vec![0; MAX_PAYLOAD + 1]), "a frame past the payload limit is refused");
        assert!(!d.send(stream ^ 1, b"x".to_vec()), "no such stream");
        // the page closes it: 1000, and the page is not told again
        assert!(d.close_stream(stream));
        assert_eq!(next(&mut ws), "close 1000");
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(heard.all().len(), 2);
    }

    #[test]
    fn a_text_message_after_ready_is_4400_and_a_message_past_the_limit_closes() {
        let heard = Arc::new(Heard::default());
        let d = door(&heard, AUTH_WAIT);
        let (_, t1, _) = token(1);
        let mut ws = dial(&d, &route(), Some(ORIGIN)).unwrap();
        hello(&mut ws, DEVICE, &t1);
        next(&mut ws);
        ws.send(Message::Text(r#"{"t":"approve"}"#.into())).unwrap();
        assert_eq!(next(&mut ws), "close 4400");
        let closed = heard.wait(2);
        assert!(closed[1].ends_with("bad_request"), "{closed:?}");
        let mut ws = dial(&d, &route(), Some(ORIGIN)).unwrap();
        hello(&mut ws, DEVICE, &t1);
        next(&mut ws);
        ws.send(Message::Binary(vec![7; MAX_PAYLOAD + 1].into())).unwrap();
        assert_eq!(next(&mut ws), "close 4413");
        let mut ws = dial(&d, &route(), Some(ORIGIN)).unwrap();
        hello(&mut ws, DEVICE, &t1);
        next(&mut ws);
        let _ = ws.send(Message::Binary(vec![7; MAX_MESSAGE + 10].into()));
        let r = next(&mut ws);
        assert!(r.starts_with("close") || r.starts_with("gone"), "{r}");
    }

    #[test]
    fn a_newer_socket_of_the_same_device_replaces_the_older_and_the_page_hears_the_old_close_first() {
        let heard = Arc::new(Heard::default());
        let d = door(&heard, AUTH_WAIT);
        let (_, t1, _) = token(1);
        let mut first = dial(&d, &route(), Some(ORIGIN)).unwrap();
        hello(&mut first, DEVICE, &t1);
        next(&mut first);
        let mut second = dial(&d, &route(), Some(ORIGIN)).unwrap();
        hello(&mut second, DEVICE, &t1);
        assert_eq!(next(&mut second), r#"{"t":"ready","v":1}"#);
        assert_eq!(next(&mut first), "close 4409");
        let h = heard.wait(3);
        let old = h[0].split(' ').nth(1).unwrap().to_string();
        assert_eq!(h[1], format!("close {old} replaced"));
        assert!(h[2].starts_with("open ") && h[2].ends_with(DEVICE));
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(heard.all().len(), 3, "the replaced stream is not closed to the page twice");
    }

    #[test]
    fn a_revoked_device_is_closed_with_4403_and_a_paused_mac_tells_a_new_phone_why() {
        let heard = Arc::new(Heard::default());
        let d = door(&heard, AUTH_WAIT);
        let (_, t1, _) = token(1);
        let (_, t2, h2) = token(2);
        let mut ws = dial(&d, &route(), Some(ORIGIN)).unwrap();
        hello(&mut ws, DEVICE, &t1);
        next(&mut ws);
        d.set_devices(&[DeviceEntry { id: OTHER.into(), token_hash: h2.clone() }]);
        assert_eq!(next(&mut ws), "close 4403");
        assert!(heard.wait(2)[1].ends_with("revoked"));
        d.set_status(HostState::Paused);
        let mut ws = dial(&d, &route(), Some(ORIGIN)).unwrap();
        hello(&mut ws, OTHER, &t2);
        let host: Value = serde_json::from_str(&next(&mut ws)).unwrap();
        assert_eq!((host["t"].as_str(), host["state"].as_str()), (Some("host"), Some("paused")));
        assert_eq!(next(&mut ws), "close 4404");
        // off closes the phones that are in, after telling them
        d.set_status(HostState::Available);
        let mut ws = dial(&d, &route(), Some(ORIGIN)).unwrap();
        hello(&mut ws, OTHER, &t2);
        next(&mut ws);
        d.set_status(HostState::Off);
        let host: Value = serde_json::from_str(&next(&mut ws)).unwrap();
        assert_eq!(host["state"], "off");
        assert_eq!(next(&mut ws), "close 4404");
    }

    #[test]
    fn device_ids_and_hashes_are_read_as_the_relay_reads_them() {
        assert!(device_ok(DEVICE));
        assert!(!device_ok("e621e1f8-c36c-495a-93fc-0c247a3e6e5f"), "upper case only, as Swift writes one");
        assert!(!device_ok("E621E1F8C36C495A93FC0C247A3E6E5F"));
        assert!(bytes32(&token(1).1).is_some());
        assert!(bytes32("AAAA").is_none());
        assert!(bytes32(&format!("{}=", &token(1).1[..42])).is_none());
        let heard = Arc::new(Heard::default());
        let d = door(&heard, AUTH_WAIT);
        d.set_devices(&[DeviceEntry { id: "lower-case-is-not-read".into(), token_hash: token(1).2 }, DeviceEntry { id: DEVICE.into(), token_hash: "short".into() }]);
        assert!(d.inner.devices.lock().unwrap().is_empty());
        assert!(same(&[1; 32], &[1; 32]) && !same(&[1; 32], &[2; 32]));
    }
}
