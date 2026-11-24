//! What the connected runtime needs from the shell (src/runtime/http/shell.ts): one HTTP request to apps/api, and one
//! keychain item that holds the session.
//!
//! Requests. The webview's own fetch is held to CORS, and the API's session routes answer none on purpose
//! (docs/pilot-api.md), so the page asks the shell. The shell runs the system's `curl`, as it reaches GitHub through
//! `gh`, which adds no HTTP library to the app. The request reaches curl on its standard input as a config file
//! (`--config -`), so the bearer token and the body are never on a command line another program could read; `-q`
//! keeps the person's own `.curlrc` out of it, and `SSLKEYLOGFILE` is taken out of curl's environment so no TLS key is
//! written anywhere. Whatever the page asks, only an https origin, or plain http on this computer (where
//! `wrangler dev` serves the API), and only paths under `/v1/` are reached, and redirects are never followed. curl is
//! run by its full system path where there is one, so a `curl` earlier on PATH never sees a token.
//!
//! The keychain. One generic password item (service `xyz.manut.desktop.api`, account `session`) that these three
//! commands read, replace and delete. The page names no item, so it can reach no other. The item is made by this app,
//! so macOS lets this app read it without asking and asks the person before any other program reads it. macOS only
//! for now: elsewhere the commands answer `unavailable` and Connected cannot sign in. One more item sits beside it,
//! account `outpost`: this Mac's outpost and its credential (outpost/item.rs). The shell alone reads that one, and no
//! command hands it to the page.
//!
//! An answer that holds a secret (an outpost redeeming a sign-in's password) is read with `request_sealed`, into a
//! buffer sized up front and wiped when it is dropped.
//!
//! The page only ever learns `offline` or `failed` (or `unavailable` for the keychain), never curl's own words, which
//! could carry an address.

use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use zeroize::Zeroizing;

// Only the macOS keychain uses these so far; on other systems they wait for its counterpart.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const KEYCHAIN_SERVICE: &str = "xyz.manut.desktop.api";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const KEYCHAIN_ACCOUNT: &str = "session";

/// The API itself refuses a larger body, so nothing larger is sent.
const MAX_BODY: usize = 256 * 1024;
/// The largest answer read back. The tenant export is the largest one the runtime reads.
const MAX_ANSWER: usize = 16 * 1024 * 1024;
/// A session is a few hundred bytes; anything far larger is not one.
const MAX_SESSION: usize = 16 * 1024;
const MAX_BEARER: usize = 8 * 1024;
const MAX_URL: usize = 2048;
/// What curl writes after the body (its `--write-out`), so the status can be told apart from the body.
const STATUS_MARK: &str = "\n__manut_status__:";

/// One answer from the API, whatever its status: the page reads a 401 or a 503 as it reads a 200.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ApiAnswer {
    pub status: u16,
    pub body: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkError {
    /// The host could not be reached: no network, no such host, nothing listening, too slow.
    Offline,
    /// The request was refused before it ran, or curl failed some other way. The reason stays in the shell.
    Failed(&'static str),
}

impl LinkError {
    /// What the page is told.
    pub fn wire(self) -> String {
        match self {
            LinkError::Offline => "offline".into(),
            LinkError::Failed(_) => "failed".into(),
        }
    }
}

/// Plain http is allowed only to these: this computer.
const LOOPBACK: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// An address the shell will reach for the page: `https://host[:port]/v1/...`, or plain http to this computer. No
/// user name before the host, no fragment, no `..` or `//` in the path, and nothing a curl config string would have
/// to escape.
pub fn checked_url(url: &str) -> Result<(), &'static str> {
    if url.len() > MAX_URL {
        return Err("address too long");
    }
    let (scheme, rest) = if let Some(rest) = url.strip_prefix("https://") {
        ("https", rest)
    } else if let Some(rest) = url.strip_prefix("http://") {
        ("http", rest)
    } else {
        return Err("not http or https");
    };
    let slash = rest.find('/').ok_or("no path")?;
    let (authority, path) = rest.split_at(slash);
    if authority.is_empty() || !authority.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']')) {
        return Err("not a host");
    }
    let host = if authority.starts_with('[') {
        let end = authority.find(']').ok_or("not a host")?;
        let (host, port) = authority.split_at(end + 1);
        checked_port(port)?;
        host
    } else {
        match authority.split_once(':') {
            Some((host, _)) => {
                checked_port(&authority[host.len()..])?;
                host
            }
            None => authority,
        }
    };
    if host.is_empty() || host.starts_with('.') || host.starts_with('-') {
        return Err("not a host");
    }
    if scheme == "http" && !LOOPBACK.contains(&host.to_ascii_lowercase().as_str()) {
        return Err("plain http off this computer");
    }
    // An encoded dot (`%2e`) is refused too: a server's URL parser reads `%2e%2e` as `..`, which would step outside
    // `/v1/`, and no API path the runtime asks for has one.
    if !path.starts_with("/v1/") || path.contains("..") || path.contains("//") || path.to_ascii_lowercase().contains("%2e") {
        return Err("not an API path");
    }
    if !path.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.' | '~' | '%' | '?' | '=' | '&' | ':')) {
        return Err("not an API path");
    }
    Ok(())
}

/// `""` (no port) or `:` and a port from 1 to 65535.
fn checked_port(port: &str) -> Result<(), &'static str> {
    if port.is_empty() {
        return Ok(());
    }
    let digits = port.strip_prefix(':').ok_or("not a port")?;
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return Err("not a port");
    }
    match digits.parse::<u16>() {
        Ok(p) if p > 0 => Ok(()),
        _ => Err("not a port"),
    }
}

/// A bearer token as the API mints them: base64url or hex, nothing a header or a config string would have to escape.
fn checked_bearer(token: &str) -> Result<(), &'static str> {
    if token.is_empty() || token.len() > MAX_BEARER {
        return Err("not a token");
    }
    if !token.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~' | '+' | '/' | '=')) {
        return Err("not a token");
    }
    Ok(())
}

/// A JSON body: within the API's own limit, and no control characters but line breaks and tabs (JSON writes the
/// others escaped, so one here means the page sent something that is not what it says).
fn checked_body(body: &str) -> Result<(), &'static str> {
    if body.len() > MAX_BODY {
        return Err("body too large");
    }
    if body.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')) {
        return Err("control character in body");
    }
    Ok(())
}

/// `value` as a curl config string's inside: `\`, `"` and the line breaks escaped, as curl's config parser reads them.
fn escape_into(out: &mut String, value: &str) {
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
}

fn config_line(out: &mut String, key: &str, value: &str) {
    out.push_str(key);
    out.push_str(" = \"");
    escape_into(out, value);
    out.push_str("\"\n");
}

/// The request as the config curl reads from its standard input. It holds the token, so it is wiped when dropped, and
/// it is sized up front so no copy of it is left behind by a reallocation.
pub fn curl_config(url: &str, method: &str, bearer: Option<&str>, body: Option<&str>) -> Zeroizing<String> {
    let room = 256 + url.len() + bearer.map_or(0, str::len) + body.map_or(0, |b| b.len() * 2);
    let mut config = Zeroizing::new(String::with_capacity(room));
    config_line(&mut config, "url", url);
    if method != "GET" {
        config_line(&mut config, "request", method);
    }
    config_line(&mut config, "header", "Accept: application/json");
    if let Some(token) = bearer {
        config.push_str("header = \"Authorization: Bearer ");
        escape_into(&mut config, token);
        config.push_str("\"\n");
    }
    if let Some(body) = body {
        config_line(&mut config, "header", "Content-Type: application/json");
        // data-raw, not data: a body that starts with `@` is sent as written, never read from a file.
        config_line(&mut config, "data-raw", body);
    }
    config
}

/// curl's command line: nothing secret, the same for every request. `-q` must come first to skip `.curlrc`.
pub fn curl_args() -> Vec<&'static str> {
    vec![
        "-q",
        "--silent",
        "--show-error",
        "--globoff",
        "--proto",
        "=http,https",
        "--connect-timeout",
        "10",
        "--max-time",
        "30",
        "--write-out",
        "\\n__manut_status__:%{http_code}",
        "--config",
        "-",
    ]
}

/// The system's own curl, by full path where the system keeps one.
fn curl_program() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Windows"));
        let system = root.join("System32").join("curl.exe");
        if system.is_file() {
            return system;
        }
    }
    #[cfg(not(target_os = "windows"))]
    for candidate in ["/usr/bin/curl", "/bin/curl"] {
        if Path::new(candidate).is_file() {
            return PathBuf::from(candidate);
        }
    }
    PathBuf::from("curl")
}

/// One request to the API for the page. Refused before anything runs unless the address, method, token and body
/// all pass the checks above.
pub fn request(url: &str, method: &str, bearer: Option<&str>, body: Option<&str>) -> Result<ApiAnswer, LinkError> {
    checked_url(url).map_err(LinkError::Failed)?;
    if !matches!(method, "GET" | "POST" | "DELETE") {
        return Err(LinkError::Failed("method"));
    }
    if let Some(token) = bearer {
        checked_bearer(token).map_err(LinkError::Failed)?;
    }
    if let Some(body) = body {
        checked_body(body).map_err(LinkError::Failed)?;
    }
    let config = curl_config(url, method, bearer, body);
    run_curl(&curl_program(), &config)
}

/// The largest answer `request_sealed` reads. A redeem's answer is a few hundred bytes: a username and a password of
/// at most 1,024 characters, and five origins.
const MAX_SEALED_ANSWER: usize = 64 * 1024;

/// One request whose answer holds a secret, such as an outpost redeeming a sign-in (outpost/api.rs). The same checks
/// and the same curl as `request`, but the answer is read into a buffer sized up front, so no reallocation leaves a
/// copy of it behind, and it comes back in a buffer that is wiped when it is dropped. Only the status and the body
/// come back, as from `request`.
pub fn request_sealed(url: &str, method: &str, bearer: Option<&str>, body: Option<&str>) -> Result<(u16, Zeroizing<String>), LinkError> {
    checked_url(url).map_err(LinkError::Failed)?;
    if !matches!(method, "GET" | "POST" | "DELETE") {
        return Err(LinkError::Failed("method"));
    }
    if let Some(token) = bearer {
        checked_bearer(token).map_err(LinkError::Failed)?;
    }
    if let Some(body) = body {
        checked_body(body).map_err(LinkError::Failed)?;
    }
    let config = curl_config(url, method, bearer, body);
    // Room for the largest answer read, the status mark and more than std's read_to_end probes with, so the buffer is
    // never full and never grows.
    let mut out = Zeroizing::new(Vec::with_capacity(MAX_SEALED_ANSWER + STATUS_MARK.len() + 128));
    match curl_into(&curl_program(), &config, &mut out, MAX_SEALED_ANSWER)? {
        Some(0) => parse_sealed(out),
        Some(code) if offline_exit(code) => Err(LinkError::Offline),
        _ => Err(LinkError::Failed("curl")),
    }
}

/// The status and the body from curl's output, as `parse_answer` reads them, moved rather than copied into a buffer
/// that is wiped when dropped.
fn parse_sealed(mut out: Zeroizing<Vec<u8>>) -> Result<(u16, Zeroizing<String>), LinkError> {
    let mark = STATUS_MARK.as_bytes();
    let at = out.windows(mark.len()).rposition(|w| w == mark).ok_or(LinkError::Failed("no status"))?;
    let status: u16 = std::str::from_utf8(&out[at + mark.len()..])
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .ok_or(LinkError::Failed("no status"))?;
    if status == 0 {
        return Err(LinkError::Offline);
    }
    out.truncate(at);
    if std::str::from_utf8(&out).is_err() {
        return Err(LinkError::Failed("not text"));
    }
    // The bytes were just checked, so this moves the buffer into the String without copying it.
    let text = String::from_utf8(std::mem::take(&mut *out)).map_err(|_| LinkError::Failed("not text"))?;
    Ok((status, Zeroizing::new(text)))
}

/// curl's exit codes that mean the host was not reached (resolving, connecting, timing out, the connection dropping),
/// as opposed to a request that was wrong.
fn offline_exit(code: i32) -> bool {
    matches!(code, 5 | 6 | 7 | 28 | 35 | 52 | 55 | 56)
}

fn run_curl(program: &Path, config: &str) -> Result<ApiAnswer, LinkError> {
    let mut out = Vec::new();
    match curl_into(program, config, &mut out, MAX_ANSWER)? {
        Some(0) => parse_answer(out),
        Some(code) if offline_exit(code) => Err(LinkError::Offline),
        _ => Err(LinkError::Failed("curl")),
    }
}

/// Runs curl with `config` on its standard input and reads at most `max` bytes of answer (and curl's status mark) into
/// `out`. Answers curl's exit code.
fn curl_into(program: &Path, config: &str, out: &mut Vec<u8>, max: usize) -> Result<Option<i32>, LinkError> {
    let mut child = Command::new(program)
        .args(curl_args())
        .env_remove("SSLKEYLOGFILE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| LinkError::Failed("no curl"))?;
    // curl reads the whole config before it starts, so the config goes in and the pipe closes before any answer
    // comes back; nothing waits on a full pipe.
    let wrote = match child.stdin.take() {
        Some(mut stdin) => stdin.write_all(config.as_bytes()).is_ok(),
        None => false,
    };
    if !wrote {
        let _ = child.kill();
        let _ = child.wait();
        return Err(LinkError::Failed("config"));
    }
    let read = match child.stdout.take() {
        Some(stdout) => stdout.take((max + STATUS_MARK.len() + 8) as u64).read_to_end(out).is_ok(),
        None => false,
    };
    let too_large = out.len() > max + STATUS_MARK.len() + 4;
    if too_large || !read {
        let _ = child.kill();
    }
    let status = child.wait().map_err(|_| LinkError::Failed("wait"))?;
    if !read {
        return Err(LinkError::Failed("read"));
    }
    if too_large {
        return Err(LinkError::Failed("answer too large"));
    }
    Ok(status.code())
}

/// The body and the status from curl's output: the body is everything before the last status mark.
fn parse_answer(out: Vec<u8>) -> Result<ApiAnswer, LinkError> {
    let text = String::from_utf8(out).map_err(|_| LinkError::Failed("not text"))?;
    let at = text.rfind(STATUS_MARK).ok_or(LinkError::Failed("no status"))?;
    let status: u16 = text[at + STATUS_MARK.len()..].trim().parse().map_err(|_| LinkError::Failed("no status"))?;
    if status == 0 {
        // curl writes 000 when no answer came back at all
        return Err(LinkError::Offline);
    }
    let mut body = text;
    body.truncate(at);
    Ok(ApiAnswer { status, body })
}

// ---- the keychain item ----------------------------------------------------------------------------------------------

/// The session as the keychain holds it, or None when there is none.
pub fn session_read() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    return mac::default_keychain().and_then(|keychain| mac::read(&keychain).map_err(String::from));
    #[cfg(not(target_os = "macos"))]
    return Err("unavailable".into());
}

/// Replaces the session the keychain holds.
pub fn session_write(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_SESSION {
        return Err("refused".into());
    }
    #[cfg(target_os = "macos")]
    return mac::default_keychain().and_then(|keychain| mac::write(&keychain, value).map_err(String::from));
    #[cfg(not(target_os = "macos"))]
    return Err("unavailable".into());
}

/// Removes the session from the keychain. Removing one that is not there is not an error.
pub fn session_clear() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return mac::default_keychain().and_then(|keychain| mac::clear(&keychain).map_err(String::from));
    #[cfg(not(target_os = "macos"))]
    return Err("unavailable".into());
}

#[cfg(target_os = "macos")]
pub(crate) mod mac {
    use super::{KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE};
    use security_framework::os::macos::keychain::SecKeychain;
    use zeroize::Zeroizing;

    /// errSecItemNotFound
    const NOT_FOUND: i32 = -25300;

    pub fn default_keychain() -> Result<SecKeychain, String> {
        SecKeychain::default().map_err(|_| "keychain".to_string())
    }

    pub fn read(keychain: &SecKeychain) -> Result<Option<String>, &'static str> {
        read_item(keychain, KEYCHAIN_ACCOUNT).map(|value| value.map(|v| v.as_str().to_owned()))
    }

    pub fn write(keychain: &SecKeychain, value: &str) -> Result<(), &'static str> {
        write_item(keychain, KEYCHAIN_ACCOUNT, value)
    }

    pub fn clear(keychain: &SecKeychain) -> Result<(), &'static str> {
        clear_item(keychain, KEYCHAIN_ACCOUNT)
    }

    /// One of this app's items by its account: `session`, or `outpost` (outpost/item.rs). What it holds comes back in a
    /// buffer that is wiped when dropped.
    pub fn read_item(keychain: &SecKeychain, account: &str) -> Result<Option<Zeroizing<String>>, &'static str> {
        match keychain.find_generic_password(KEYCHAIN_SERVICE, account) {
            Ok((password, _item)) => {
                let bytes = Zeroizing::new(password.to_vec());
                std::str::from_utf8(&bytes).map(|text| Some(Zeroizing::new(text.to_owned()))).map_err(|_| "keychain")
            }
            Err(e) if e.code() == NOT_FOUND => Ok(None),
            Err(_) => Err("keychain"),
        }
    }

    pub fn write_item(keychain: &SecKeychain, account: &str, value: &str) -> Result<(), &'static str> {
        keychain.set_generic_password(KEYCHAIN_SERVICE, account, value.as_bytes()).map_err(|_| "keychain")
    }

    pub fn clear_item(keychain: &SecKeychain, account: &str) -> Result<(), &'static str> {
        match keychain.find_generic_password(KEYCHAIN_SERVICE, account) {
            Ok((_, item)) => {
                item.delete();
                Ok(())
            }
            Err(e) if e.code() == NOT_FOUND => Ok(()),
            Err(_) => Err("keychain"),
        }
    }
}

/// A keychain of a test's own in a temporary folder, so the person's login keychain is never touched. It is deleted,
/// and taken off the search list, when the test ends. Used by this file's tests and the outpost's (outpost/item.rs).
#[cfg(all(test, target_os = "macos"))]
pub(crate) mod scratch_keychain {
    use core_foundation::base::TCFType;
    use security_framework::os::macos::keychain::{CreateOptions, SecKeychain};
    use security_framework_sys::base::SecKeychainRef;
    use std::path::PathBuf;

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        /// Takes a keychain off the user's search list and deletes its file (not in security-framework-sys).
        fn SecKeychainDelete(keychain: SecKeychainRef) -> i32;
    }

    pub struct Scratch {
        pub keychain: SecKeychain,
        dir: PathBuf,
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            // SAFETY: the keychain reference is valid for as long as `self.keychain` lives, which outlasts the call.
            unsafe {
                SecKeychainDelete(self.keychain.as_concrete_TypeRef());
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    pub fn scratch(tag: &str) -> Scratch {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("manut-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut keychain = CreateOptions::new().password("test-only").create(dir.join("test.keychain")).unwrap();
        keychain.unlock(Some("test-only")).unwrap();
        Scratch { keychain, dir }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread::JoinHandle;
    use std::time::Duration;

    fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
        hay.windows(needle.len()).position(|w| w == needle)
    }

    /// A one-request HTTP server on this computer: it answers `status` with `body` and hands back the request it got.
    fn serve_once(status: u16, body: &'static str) -> (String, JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
            let mut seen = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = stream.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                seen.extend_from_slice(&buf[..n]);
                if let Some(end) = find(&seen, b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&seen[..end]).to_string();
                    let length = head
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    while seen.len() < end + 4 + length {
                        let n = stream.read(&mut buf).unwrap();
                        if n == 0 {
                            break;
                        }
                        seen.extend_from_slice(&buf[..n]);
                    }
                    break;
                }
            }
            let reply = format!(
                "HTTP/1.1 {status} Answer\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(reply.as_bytes()).unwrap();
            String::from_utf8_lossy(&seen).to_string()
        });
        (origin, handle)
    }

    #[test]
    fn reads_an_answer_with_the_token_in_a_header_and_never_on_the_command_line() {
        let (origin, server) = serve_once(200, r#"{"schedules":[]}"#);
        let answer = request(&format!("{origin}/v1/schedules"), "GET", Some("tok-abc123"), None).unwrap();
        assert_eq!(answer, ApiAnswer { status: 200, body: r#"{"schedules":[]}"#.into() });
        let seen = server.join().unwrap();
        assert!(seen.starts_with("GET /v1/schedules HTTP/1.1\r\n"), "{seen}");
        assert!(seen.contains("\r\nAuthorization: Bearer tok-abc123\r\n"), "{seen}");
        assert!(seen.contains("\r\nAccept: application/json\r\n"), "{seen}");
        assert!(curl_args().iter().all(|a| !a.contains("tok-abc123")));
    }

    #[test]
    fn posts_a_body_exactly_as_the_page_wrote_it() {
        let (origin, server) = serve_once(200, r#"{"accessToken":"a"}"#);
        let body = r#"{"refreshToken":"r\"x\\y @z","deviceId":"ร้านมะลิ"}"#;
        let answer = request(&format!("{origin}/v1/auth/refresh"), "POST", None, Some(body)).unwrap();
        assert_eq!(answer.status, 200);
        let seen = server.join().unwrap();
        assert!(seen.starts_with("POST /v1/auth/refresh HTTP/1.1\r\n"), "{seen}");
        assert!(seen.contains("\r\nContent-Type: application/json\r\n"), "{seen}");
        assert!(!seen.contains("Authorization:"), "{seen}");
        assert!(seen.ends_with(&format!("\r\n\r\n{body}")), "{seen}");
    }

    #[test]
    fn deletes_and_reads_a_refusal_or_a_server_error_as_an_answer() {
        let (origin, server) = serve_once(401, r#"{"error":"invalid_session"}"#);
        let answer = request(&format!("{origin}/v1/auth/session"), "DELETE", Some("tok"), None).unwrap();
        assert_eq!(answer, ApiAnswer { status: 401, body: r#"{"error":"invalid_session"}"#.into() });
        assert!(server.join().unwrap().starts_with("DELETE /v1/auth/session HTTP/1.1\r\n"));
        let (origin, server) = serve_once(503, "");
        assert_eq!(request(&format!("{origin}/v1/schedules"), "GET", None, None).unwrap(), ApiAnswer { status: 503, body: String::new() });
        server.join().unwrap();
    }

    #[test]
    fn says_offline_when_nothing_answers() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert_eq!(request(&format!("http://127.0.0.1:{port}/v1/schedules"), "GET", None, None), Err(LinkError::Offline));
        assert_eq!(LinkError::Offline.wire(), "offline");
        assert_eq!(LinkError::Failed("x").wire(), "failed");
    }

    #[test]
    fn reaches_only_api_paths_on_https_origins_or_this_computer() {
        for ok in [
            "https://dev.manut.xyz/v1/schedules",
            "https://dev.manut.xyz:8443/v1/tenant/export",
            "https://DEV.manut.xyz/v1/tasks/task-1/events?after=3&limit=200",
            "http://localhost:8787/v1/auth/exchange",
            "http://127.0.0.1:8787/v1/schedules",
            "http://[::1]:8787/v1/schedules",
        ] {
            assert_eq!(checked_url(ok), Ok(()), "{ok}");
        }
        for bad in [
            "http://dev.manut.xyz/v1/schedules",
            "http://localhost.evil.example/v1/schedules",
            "https://dev.manut.xyz@evil.example/v1/schedules",
            "https://user:pw@dev.manut.xyz/v1/schedules",
            "https://dev.manut.xyz",
            "https://dev.manut.xyz/",
            "https://dev.manut.xyz/admin",
            "https://dev.manut.xyz/v1/../admin",
            "https://dev.manut.xyz/v1//x",
            // an encoded dot segment that a server's URL parser would read as `..`
            "https://dev.manut.xyz/v1/%2e%2e/admin",
            "https://dev.manut.xyz/v1/%2E./admin",
            "https://dev.manut.xyz/v1/x#frag",
            "https://dev.manut.xyz/v1/x y",
            "https://dev.manut.xyz/v1/x\"\nurl = \"https://evil.example/",
            "https://dev.manut.xyz:0/v1/x",
            "https://dev.manut.xyz:99999/v1/x",
            "https://dev.manut.xyz:+80/v1/x",
            "https://:80/v1/x",
            "file:///etc/passwd",
            "ftp://dev.manut.xyz/v1/x",
        ] {
            assert!(checked_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn refuses_a_method_token_or_body_it_was_not_made_for_without_running_anything() {
        let url = "http://127.0.0.1:9/v1/schedules";
        assert_eq!(request(url, "PUT", None, None), Err(LinkError::Failed("method")));
        assert!(matches!(request(url, "GET", Some("tok\nheader = \"X: y"), None), Err(LinkError::Failed(_))));
        assert!(matches!(request(url, "GET", Some(""), None), Err(LinkError::Failed(_))));
        assert!(matches!(request(url, "POST", None, Some(&"x".repeat(MAX_BODY + 1))), Err(LinkError::Failed(_))));
        assert!(matches!(request(url, "POST", None, Some("{\u{0}}")), Err(LinkError::Failed(_))));
        assert!(matches!(request("https://evil.example/admin", "GET", Some("tok"), None), Err(LinkError::Failed(_))));
    }

    #[test]
    fn writes_the_request_as_a_config_whose_strings_cannot_be_broken_out_of() {
        let config = curl_config("https://dev.manut.xyz/v1/auth/refresh", "POST", Some("tok"), Some("{\"a\":\"b\\\"c\nd\"}"));
        assert_eq!(
            config.as_str(),
            "url = \"https://dev.manut.xyz/v1/auth/refresh\"\nrequest = \"POST\"\nheader = \"Accept: application/json\"\nheader = \"Authorization: Bearer tok\"\nheader = \"Content-Type: application/json\"\ndata-raw = \"{\\\"a\\\":\\\"b\\\\\\\"c\\nd\\\"}\"\n"
        );
        // a GET names no method and sends no body
        assert_eq!(
            curl_config("https://dev.manut.xyz/v1/schedules", "GET", None, None).as_str(),
            "url = \"https://dev.manut.xyz/v1/schedules\"\nheader = \"Accept: application/json\"\n"
        );
        assert_eq!(curl_args()[0], "-q");
    }

    #[test]
    fn takes_the_status_from_the_last_mark_so_a_body_cannot_forge_one() {
        let out = format!("{{\"text\":\"{}200\"}}{}404", STATUS_MARK, STATUS_MARK).into_bytes();
        assert_eq!(parse_answer(out).unwrap(), ApiAnswer { status: 404, body: format!("{{\"text\":\"{}200\"}}", STATUS_MARK) });
        assert_eq!(parse_answer(format!("{}000", STATUS_MARK).into_bytes()), Err(LinkError::Offline));
        assert!(parse_answer(b"no mark".to_vec()).is_err());
    }

    #[test]
    fn reads_a_sealed_answer_with_its_status_and_refuses_one_too_large() {
        let (origin, server) = serve_once(200, r#"{"password":"p\"w é"}"#);
        let (status, body) = request_sealed(&format!("{origin}/v1/outposts/redeem"), "POST", Some("mo1_tok"), Some("{}")).unwrap();
        assert_eq!(status, 200);
        assert_eq!(body.as_str(), r#"{"password":"p\"w é"}"#);
        let seen = server.join().unwrap();
        assert!(seen.contains("\r\nAuthorization: Bearer mo1_tok\r\n"), "{seen}");
        // a refusal comes back with its status, as from `request`
        let (origin, server) = serve_once(409, r#"{"error":"grant_used"}"#);
        let (status, body) = request_sealed(&format!("{origin}/v1/outposts/redeem"), "POST", Some("mo1_tok"), Some("{}")).unwrap();
        assert_eq!((status, body.as_str()), (409, r#"{"error":"grant_used"}"#));
        server.join().unwrap();
        let large: &'static str = Box::leak("x".repeat(MAX_SEALED_ANSWER + 1024).into_boxed_str());
        let (origin, server) = serve_once(200, large);
        assert!(matches!(request_sealed(&format!("{origin}/v1/outposts/redeem"), "POST", None, None), Err(LinkError::Failed(_))));
        let _ = server.join();
        // the same address and token checks as `request`, before anything runs
        assert!(matches!(request_sealed("https://evil.example/admin", "POST", None, None), Err(LinkError::Failed(_))));
        assert!(matches!(parse_sealed(Zeroizing::new(format!("{}000", STATUS_MARK).into_bytes())), Err(LinkError::Offline)));
    }

    #[test]
    fn refuses_to_keep_an_empty_or_oversized_session() {
        assert_eq!(session_write(""), Err("refused".to_string()));
        assert_eq!(session_write(&"x".repeat(MAX_SESSION + 1)), Err("refused".to_string()));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn has_no_keychain_outside_macos_yet() {
        assert_eq!(session_read(), Err("unavailable".to_string()));
        assert_eq!(session_write("{}"), Err("unavailable".to_string()));
        assert_eq!(session_clear(), Err("unavailable".to_string()));
    }

    #[cfg(target_os = "macos")]
    mod keychain {
        use super::super::mac;
        use super::super::scratch_keychain::scratch;

        #[test]
        fn keeps_one_session_item_reads_replaces_and_clears_it() {
            let s = scratch("api-link");
            assert_eq!(mac::read(&s.keychain), Ok(None));
            mac::write(&s.keychain, r#"{"v":1,"accessToken":"a-1"}"#).unwrap();
            assert_eq!(mac::read(&s.keychain), Ok(Some(r#"{"v":1,"accessToken":"a-1"}"#.into())));
            mac::write(&s.keychain, r#"{"v":1,"accessToken":"a-2"}"#).unwrap();
            assert_eq!(mac::read(&s.keychain), Ok(Some(r#"{"v":1,"accessToken":"a-2"}"#.into())));
            mac::clear(&s.keychain).unwrap();
            assert_eq!(mac::read(&s.keychain), Ok(None));
            // clearing what is not there is not an error
            mac::clear(&s.keychain).unwrap();
        }
    }
}
