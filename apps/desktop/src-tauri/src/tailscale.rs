//! Whether this Mac can be reached over Tailscale under its own HTTPS name (item 78f, docs/remote-access.md, "The second
//! road: Tailscale"). Read only: the one program run here is the person's own Tailscale CLI with exactly `status --json
//! --peers=false`, through tasks.rs's runner (no shell, nothing on stdin), with a deadline and a cap on what is read.
//! Nothing here starts Tailscale, signs in, serves, or changes a setting; those are the person's own steps, and the
//! listener and `tailscale serve` are a later part of the item.
//!
//! What leaves this module is one of four words and, only when ready, this Mac's name on the tailnet. Of the CLI's answer
//! only `BackendState`, `Self.DNSName`, `CertDomains`, `MagicDNSSuffix` and `CurrentTailnet.MagicDNSEnabled` are parsed
//! into values (field names read on Tailscale 1.104.7's own answer, names only); every other field (addresses, the user,
//! keys, peers) is skipped by the parser, and nothing of the answer is logged or put in an error. The CLI's help warns
//! that the JSON changes between releases, so whatever this reader does not understand is `signed_out` or
//! `needs_https`, never `ready`.
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::tasks::run_capped;

/// The one argv (after the program) ever run: the status as JSON, without the other devices of the tailnet (the flag is
/// in `tailscale status --help` on 1.104.7), so the answer stays a few kilobytes and holds no peer at all.
pub const ARGV: [&str; 3] = ["status", "--json", "--peers=false"];

/// How long the CLI may take. It asks the local Tailscale service only, which answers at once when it is there.
pub const LIMIT: Duration = Duration::from_secs(5);

/// The most bytes of the answer read. This Mac's answer without peers was about 3.4 KB; an answer past this cap is not
/// read at all, so it can never be `ready`.
pub const CAP: u64 = 1 << 20;

/// Where the CLI is looked for after PATH, in this order: the command Tailscale's own "Install CLI" puts in
/// /usr/local/bin (on this Mac, a two-line script that runs the app's binary with the same arguments, each passed as it
/// is), Homebrew's, and the app's own binary, which acts as the CLI when it is given arguments. The app started from the
/// Dock or Finder has a short PATH, so these are where it is usually found.
pub const KNOWN: [&str; 3] = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

/// What Settings says about Tailscale on this Mac. `Ready` carries the Mac's name on the tailnet (`mac.tail1234.ts.net`,
/// no trailing dot, lowercase); the others carry nothing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Tailscale {
    /// no Tailscale CLI on this computer
    Missing,
    /// the CLI is here, but Tailscale is not running and signed in (or did not answer, or answered what is not read)
    SignedOut,
    /// running, but the tailnet has no MagicDNS name or no HTTPS certificate for this Mac (or its name is not one this
    /// reader accepts)
    NeedsHttps,
    /// running, with MagicDNS on and an HTTPS certificate domain that is this Mac's name
    Ready { name: String },
}

/// The first read of the answer: only its state. Any other field is skipped and never becomes a value here.
#[derive(Deserialize)]
struct Head {
    #[serde(rename = "BackendState")]
    backend_state: String,
}

/// The second read, once the state is `Running`: the four fields the name is judged by, and nothing else.
#[derive(Deserialize)]
struct Rest {
    #[serde(rename = "Self")]
    me: Option<Node>,
    #[serde(rename = "CertDomains")]
    cert_domains: Option<Vec<String>>,
    #[serde(rename = "MagicDNSSuffix")]
    suffix: Option<String>,
    #[serde(rename = "CurrentTailnet")]
    tailnet: Option<Tailnet>,
}

#[derive(Deserialize)]
struct Node {
    #[serde(rename = "DNSName")]
    dns_name: Option<String>,
}

#[derive(Deserialize)]
struct Tailnet {
    #[serde(rename = "MagicDNSEnabled")]
    magic_dns: Option<bool>,
}

/// A name as the tailnet writes it, made comparable: its one trailing dot dropped and its ASCII letters lowercased.
/// Anything else in it stays, so the checks below refuse it.
fn plain(name: &str) -> String {
    name.strip_suffix('.').unwrap_or(name).to_ascii_lowercase()
}

/// One DNS label: 1 to 63 lowercase letters, digits and hyphens, not starting or ending with a hyphen.
fn label_ok(l: &str) -> bool {
    !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A tailnet name this reader accepts (already `plain`): DNS labels only, at most 253 bytes, under `ts.net` with at
/// least one label of its own. A space, a slash, an underscore, a control character, a letter outside ASCII or another
/// domain is refused, so the page and a later `tailscale serve` only ever see a plain host name.
pub fn name_ok(n: &str) -> bool {
    n.len() <= 253 && n.ends_with(".ts.net") && n.split('.').count() >= 3 && n.split('.').all(label_ok)
}

/// The state an answer of `tailscale status --json` says, judged by the fields above only.
pub fn judge(out: &str) -> Tailscale {
    // an object only: serde would also read a list as the struct's fields in order
    if !out.trim_start().starts_with('{') {
        return Tailscale::SignedOut;
    }
    // a field given twice is refused by the parser, so a doubled `BackendState` is never read as either
    let Ok(head) = serde_json::from_str::<Head>(out) else { return Tailscale::SignedOut };
    if head.backend_state != "Running" {
        return Tailscale::SignedOut;
    }
    let Ok(rest) = serde_json::from_str::<Rest>(out) else { return Tailscale::NeedsHttps };
    // MagicDNS off: the name does not resolve on a phone, whatever certificate there is
    if rest.tailnet.and_then(|t| t.magic_dns) != Some(true) {
        return Tailscale::NeedsHttps;
    }
    let Some(suffix) = rest.suffix.map(|s| plain(&s)).filter(|s| name_ok(s)) else { return Tailscale::NeedsHttps };
    let Some(name) = rest.me.and_then(|m| m.dns_name).map(|n| plain(&n)) else { return Tailscale::NeedsHttps };
    if !name_ok(&name) || !name.ends_with(&format!(".{suffix}")) {
        return Tailscale::NeedsHttps;
    }
    // HTTPS Certificates on: the tailnet lists this Mac's name among the domains it can have a certificate for
    if !rest.cert_domains.unwrap_or_default().iter().any(|c| plain(c) == name) {
        return Tailscale::NeedsHttps;
    }
    Tailscale::Ready { name }
}

/// Where the CLI is: the first program named `tailscale` in PATH's absolute folders (a relative folder would find a
/// program in whatever folder the app happens to run in), then the first of `known`.
pub fn locate(path: Option<&OsStr>, known: &[PathBuf], is_program: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let name = if cfg!(windows) { "tailscale.exe" } else { "tailscale" };
    let on_path: Vec<PathBuf> = path.map(|p| std::env::split_paths(p).filter(|d| d.is_absolute()).map(|d| d.join(name)).collect()).unwrap_or_default();
    on_path.into_iter().chain(known.iter().cloned()).find(|p| is_program(p))
}

/// The state, read through the CLI at `exe` (None: there is none) with deadline `limit` and at most `cap` bytes of
/// its answer. A CLI that does not start, fails, does not answer in time or answers more than `cap` is `signed_out`.
pub fn read_with(exe: Option<&Path>, limit: Duration, cap: u64) -> Tailscale {
    let Some(exe) = exe else { return Tailscale::Missing };
    let argv: Vec<String> = ARGV.iter().map(|a| a.to_string()).collect();
    // one byte past the cap is read, so an answer that is longer is told from one that is exactly the cap
    match run_capped(exe, &argv, limit, cap.saturating_add(1)) {
        Ok(ran) if ran.code == Some(0) && (ran.out.len() as u64) <= cap => judge(&ran.out),
        _ => Tailscale::SignedOut,
    }
}

/// The state on this computer.
pub fn read() -> Tailscale {
    let known: Vec<PathBuf> = KNOWN.iter().map(PathBuf::from).collect();
    let exe = locate(std::env::var_os("PATH").as_deref(), &known, crate::sessions::is_program_file);
    read_with(exe.as_deref(), LIMIT, CAP)
}

/// Settings, Sharing and access: Tailscale on this Mac, as one of four states (and the Mac's name when ready). Only
/// reads; the page sends nothing.
#[tauri::command]
pub async fn tailscale_state() -> Result<Tailscale, String> {
    tauri::async_runtime::spawn_blocking(read).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    /// An answer in the shape of Tailscale 1.104.7's (its top-level and `Self` field names), every value made up.
    fn answer(state: &str, name: &str, certs: &[&str], suffix: &str, magic: bool) -> Value {
        json!({
            "Version": "1.104.7-tFAKE",
            "TUN": false,
            "BackendState": state,
            "HaveNodeKey": true,
            "AuthURL": "",
            "TailscaleIPs": ["100.64.0.7", "fd7a:115c:a1e0::7"],
            "Self": {
                "ID": "nFAKE7", "PublicKey": "nodekey:fakefakefakefake", "HostName": "Shop Mac", "DNSName": name, "OS": "macOS",
                "UserID": 42, "TailscaleIPs": ["100.64.0.7"], "CurAddr": "203.0.113.9:41641", "Online": true
            },
            "Health": [],
            "MagicDNSSuffix": suffix,
            "CurrentTailnet": { "Name": "someone@example.com", "MagicDNSSuffix": suffix, "MagicDNSEnabled": magic },
            "CertDomains": certs,
            "Peer": null,
            "User": { "42": { "ID": 42, "LoginName": "someone@example.com", "DisplayName": "Some One" } },
            "ClientVersion": null
        })
    }

    fn ready_answer() -> Value {
        answer("Running", "mac.tail1234.ts.net.", &["mac.tail1234.ts.net"], "tail1234.ts.net", true)
    }

    fn ready() -> Tailscale {
        Tailscale::Ready { name: "mac.tail1234.ts.net".into() }
    }

    fn with(mut v: Value, f: impl FnOnce(&mut Value)) -> String {
        f(&mut v);
        v.to_string()
    }

    #[test]
    fn each_state_of_the_answer() {
        assert_eq!(judge(&ready_answer().to_string()), ready());
        // stopped, needing a login or approval, starting, or a state this reader does not know: sign in
        for state in ["Stopped", "NeedsLogin", "NeedsMachineAuth", "Starting", "NoState", "InUseOtherUser", "running", "Running ", ""] {
            let v = answer(state, "mac.tail1234.ts.net.", &["mac.tail1234.ts.net"], "tail1234.ts.net", true);
            assert_eq!(judge(&v.to_string()), Tailscale::SignedOut, "{state:?}");
        }
        // running, but no certificate for this Mac: HTTPS is off for the tailnet
        assert_eq!(judge(&answer("Running", "mac.tail1234.ts.net.", &[], "tail1234.ts.net", true).to_string()), Tailscale::NeedsHttps);
        assert_eq!(judge(&with(ready_answer(), |v| v["CertDomains"] = Value::Null)), Tailscale::NeedsHttps);
        assert_eq!(judge(&with(ready_answer(), |v| {
            v.as_object_mut().unwrap().remove("CertDomains");
        })), Tailscale::NeedsHttps);
        // MagicDNS off, or not said
        assert_eq!(judge(&answer("Running", "mac.tail1234.ts.net.", &["mac.tail1234.ts.net"], "tail1234.ts.net", false).to_string()), Tailscale::NeedsHttps);
        assert_eq!(judge(&with(ready_answer(), |v| {
            v["CurrentTailnet"].as_object_mut().unwrap().remove("MagicDNSEnabled");
        })), Tailscale::NeedsHttps);
        assert_eq!(judge(&with(ready_answer(), |v| v["CurrentTailnet"] = Value::Null)), Tailscale::NeedsHttps);
        // no MagicDNS name: none for this Mac, or no suffix for the tailnet
        assert_eq!(judge(&answer("Running", "", &["mac.tail1234.ts.net"], "tail1234.ts.net", true).to_string()), Tailscale::NeedsHttps);
        assert_eq!(judge(&with(ready_answer(), |v| v["Self"] = Value::Null)), Tailscale::NeedsHttps);
        assert_eq!(judge(&answer("Running", "mac.tail1234.ts.net.", &["mac.tail1234.ts.net"], "", true).to_string()), Tailscale::NeedsHttps);
        // a field of another type than this reader knows: not understood, so not ready
        assert_eq!(judge(&with(ready_answer(), |v| v["CertDomains"] = json!("mac.tail1234.ts.net"))), Tailscale::NeedsHttps);
        assert_eq!(judge(&with(ready_answer(), |v| v["CertDomains"] = json!(["mac.tail1234.ts.net", 7]))), Tailscale::NeedsHttps);
        assert_eq!(judge(&with(ready_answer(), |v| v["Self"]["DNSName"] = json!(["mac.tail1234.ts.net."]))), Tailscale::NeedsHttps);
        assert_eq!(judge(&with(ready_answer(), |v| v["CurrentTailnet"]["MagicDNSEnabled"] = json!("true"))), Tailscale::NeedsHttps);
        // the name without its trailing dot, and certificate domains written with one, are the same name
        assert_eq!(judge(&answer("Running", "mac.tail1234.ts.net", &["mac.tail1234.ts.net."], "tail1234.ts.net.", true).to_string()), ready());
    }

    #[test]
    fn garbage_is_never_ready() {
        let r = ready_answer().to_string();
        for bad in [
            "".to_string(),
            "not json".into(),
            "null".into(),
            "[]".into(),
            r#"["Running"]"#.into(),
            "{}".into(),
            r#"{"BackendState":1}"#.into(),
            r#"{"BackendState":null}"#.into(),
            format!("{r} trailing"),
            r[..r.len() / 2].to_string(),
            // a doubled state is refused, whichever comes first
            r#"{"BackendState":"Stopped","BackendState":"Running"}"#.into(),
            r.replacen(r#""BackendState":"Running""#, r#""BackendState":"Running","BackendState":"Running""#, 1),
        ] {
            assert_eq!(judge(&bad), Tailscale::SignedOut, "{bad}");
        }
        // running with nothing else, or a doubled Self: running, but no name this reader trusts
        assert_eq!(judge(r#"{"BackendState":"Running"}"#), Tailscale::NeedsHttps);
        let doubled = r.replacen(r#""Self":{"#, r#""Self":{"DNSName":"evil.tail1234.ts.net."},"Self":{"#, 1);
        assert_ne!(doubled, r);
        assert_eq!(judge(&doubled), Tailscale::NeedsHttps);
    }

    #[test]
    fn a_hostile_or_odd_name_is_never_ready() {
        let suffix = "tail1234.ts.net";
        // uppercase is lowered, and that is all that is changed
        assert_eq!(judge(&answer("Running", "MAC.Tail1234.TS.net.", &["mac.tail1234.ts.net"], suffix, true).to_string()), ready());
        assert_eq!(judge(&answer("Running", "mac.tail1234.ts.net.", &["MAC.TAIL1234.TS.NET"], "TAIL1234.ts.net", true).to_string()), ready());
        let long = format!("{}.{suffix}", ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(50)].join("."));
        assert!(long.len() > 253);
        for name in [
            "my mac.tail1234.ts.net.",
            "a/b.tail1234.ts.net.",
            "../tail1234.ts.net.",
            "mac\u{7}.tail1234.ts.net.",
            "mac\n.tail1234.ts.net.",
            "mac\u{0}.tail1234.ts.net.",
            "my_mac.tail1234.ts.net.",
            "evil.com.",
            "evil.com",
            "x.ts.net.evil.com.",
            "mac.tail1234.ts.net.evil.com.",
            "mac.tail1234.ts.net..",
            "mac..tail1234.ts.net.",
            ".tail1234.ts.net.",
            "-mac.tail1234.ts.net.",
            "mac-.tail1234.ts.net.",
            "mäc.tail1234.ts.net.",
            "mac.tail1234.ts.net:443.",
            "https://mac.tail1234.ts.net.",
            "mac@tail1234.ts.net.",
            "mac.tail1234.ts.net/x.",
            "mac.tail1234.ts.net ",
            " mac.tail1234.ts.net.",
            // another tailnet's name, or the tailnet's own suffix
            "mac.tail9999.ts.net.",
            "tail1234.ts.net.",
            "ts.net.",
            &long,
            &format!("{}.{suffix}.", "a".repeat(64)),
        ] {
            // the name is in CertDomains too, so it is the name's own check that refuses it
            let v = answer("Running", name, &[name, name.trim_end_matches('.')], suffix, true);
            assert_eq!(judge(&v.to_string()), Tailscale::NeedsHttps, "{name:?}");
        }
        // a good name that is not one of CertDomains
        assert_eq!(judge(&answer("Running", "mac.tail1234.ts.net.", &["other.tail1234.ts.net", "*.tail1234.ts.net"], suffix, true).to_string()), Tailscale::NeedsHttps);
        // a suffix that is not under ts.net makes even a good-looking name not ready
        for bad in ["evil.com", "ts.net", "tail 1234.ts.net", "tail1234.ts.net.evil.com"] {
            let v = answer("Running", "mac.tail1234.ts.net.", &["mac.tail1234.ts.net"], bad, true);
            assert_eq!(judge(&v.to_string()), Tailscale::NeedsHttps, "{bad}");
        }
        assert!(name_ok("mac.tail1234.ts.net") && name_ok("xn--mc-tka.tail1234.ts.net") && name_ok("a-1.b-2.ts.net"));
        assert!(!name_ok("MAC.tail1234.ts.net") && !name_ok("mac.tail1234.ts.net.") && !name_ok(""));
    }

    #[test]
    fn nothing_but_the_state_and_the_name_leaves() {
        assert_eq!(serde_json::to_string(&ready()).unwrap(), r#"{"state":"ready","name":"mac.tail1234.ts.net"}"#);
        assert_eq!(serde_json::to_string(&Tailscale::Missing).unwrap(), r#"{"state":"missing"}"#);
        assert_eq!(serde_json::to_string(&Tailscale::SignedOut).unwrap(), r#"{"state":"signed_out"}"#);
        assert_eq!(serde_json::to_string(&Tailscale::NeedsHttps).unwrap(), r#"{"state":"needs_https"}"#);
        let got = judge(&ready_answer().to_string());
        let dump = format!("{got:?}{}", serde_json::to_string(&got).unwrap());
        for secret in ["100.64", "fd7a", "203.0.113", "nodekey", "someone@", "Some One", "Shop Mac", "nFAKE", "tFAKE", "42"] {
            assert!(!dump.contains(secret), "{secret} in {dump}");
        }
    }

    #[test]
    fn finds_the_cli_on_path_then_in_the_known_places() {
        let d = std::env::temp_dir().join(format!("manut-ts-find-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let (a, b, k1, k2) = (d.join("a"), d.join("b"), d.join("known1/tailscale"), d.join("known2/Tailscale"));
        for dir in [&a, &b, &d.join("known1"), &d.join("known2")] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let is = |p: &Path| p.is_file();
        let path = std::env::join_paths([&a, &b]).unwrap();
        let known = vec![k1.clone(), k2.clone()];
        // nothing anywhere
        assert_eq!(locate(Some(&path), &known, is), None);
        assert_eq!(locate(None, &[], is), None);
        // the known places, in order
        std::fs::write(&k2, "").unwrap();
        assert_eq!(locate(Some(&path), &known, is), Some(k2.clone()));
        std::fs::write(&k1, "").unwrap();
        assert_eq!(locate(None, &known, is), Some(k1.clone()));
        // PATH comes first, its folders in order
        std::fs::write(b.join("tailscale"), "").unwrap();
        assert_eq!(locate(Some(&path), &known, is), Some(b.join("tailscale")));
        std::fs::write(a.join("tailscale"), "").unwrap();
        assert_eq!(locate(Some(&path), &known, is), Some(a.join("tailscale")));
        // a relative PATH folder is never searched, even when it holds one
        let here = std::env::current_dir().unwrap();
        let rel = std::env::join_paths([Path::new("relative-folder"), Path::new(".")]).unwrap();
        let only_rel = |p: &Path| p.is_relative() || p.starts_with(&here);
        assert_eq!(locate(Some(&rel), &[], only_rel), None);
        // the places this computer is searched in, in the brief's order
        assert_eq!(KNOWN, ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn no_cli_is_missing() {
        assert_eq!(read_with(None, LIMIT, CAP), Tailscale::Missing);
        let d = std::env::temp_dir().join(format!("manut-ts-none-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        let path = std::env::join_paths([&d]).unwrap();
        assert_eq!(locate(Some(&path), &[d.join("nope")], crate::sessions::is_program_file), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A stand-in `tailscale` in a folder of its own: it logs each argument in brackets on one line of `calls.log`,
    /// then hangs when `hang` is there, else prints `answer.json` and exits with the code in `code` (0 without one).
    #[cfg(unix)]
    fn stub(tag: &str, answer: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let d = std::env::temp_dir().join(format!("manut-ts-stub-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let script = r#"#!/bin/sh
dir="$(dirname "$0")"
for a in "$@"; do printf '[%s]' "$a" >> "$dir/calls.log"; done
echo >> "$dir/calls.log"
if [ -f "$dir/hang" ]; then exec sleep 10; fi
cat "$dir/answer.json"
if [ -f "$dir/code" ]; then exit "$(cat "$dir/code")"; fi
exit 0
"#;
        std::fs::write(d.join("tailscale"), script).unwrap();
        std::fs::set_permissions(d.join("tailscale"), std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(d.join("answer.json"), answer).unwrap();
        d
    }

    /// Every call the stand-in got was exactly `status --json --peers=false`; returns how many.
    #[cfg(unix)]
    fn only_status_was_run(d: &Path) -> usize {
        let log = std::fs::read_to_string(d.join("calls.log")).unwrap_or_default();
        for l in log.lines() {
            assert_eq!(l, "[status][--json][--peers=false]");
        }
        log.lines().count()
    }

    #[cfg(unix)]
    #[test]
    fn reads_each_state_through_the_cli_and_runs_only_status() {
        let cases = [
            ("ready", ready_answer().to_string(), ready()),
            ("stopped", answer("Stopped", "mac.tail1234.ts.net.", &["mac.tail1234.ts.net"], "tail1234.ts.net", true).to_string(), Tailscale::SignedOut),
            ("login", answer("NeedsLogin", "", &[], "", false).to_string(), Tailscale::SignedOut),
            ("nohttps", answer("Running", "mac.tail1234.ts.net.", &[], "tail1234.ts.net", true).to_string(), Tailscale::NeedsHttps),
            ("nodns", answer("Running", "mac.tail1234.ts.net.", &["mac.tail1234.ts.net"], "tail1234.ts.net", false).to_string(), Tailscale::NeedsHttps),
            ("hostile", answer("Running", "x.ts.net.evil.com.", &["x.ts.net.evil.com"], "tail1234.ts.net", true).to_string(), Tailscale::NeedsHttps),
            ("garbage", "Tailscale is stopped.\n".to_string(), Tailscale::SignedOut),
            ("empty", String::new(), Tailscale::SignedOut),
        ];
        for (tag, out, want) in cases {
            let d = stub(tag, &out);
            assert_eq!(read_with(Some(&d.join("tailscale")), LIMIT, CAP), want, "{tag}");
            assert_eq!(only_status_was_run(&d), 1, "{tag}");
            let _ = std::fs::remove_dir_all(&d);
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_slow_or_oversized_answer_is_not_ready() {
        // a ready answer with a non-zero exit is not believed
        let d = stub("exit", &ready_answer().to_string());
        std::fs::write(d.join("code"), "1").unwrap();
        assert_eq!(read_with(Some(&d.join("tailscale")), LIMIT, CAP), Tailscale::SignedOut);
        std::fs::write(d.join("code"), "0").unwrap();
        assert_eq!(read_with(Some(&d.join("tailscale")), LIMIT, CAP), ready(), "the same stand-in is ready when it exits 0");
        assert_eq!(only_status_was_run(&d), 2);
        let _ = std::fs::remove_dir_all(&d);

        // a CLI that hangs is cut off at the deadline
        let d = stub("hang", &ready_answer().to_string());
        std::fs::write(d.join("hang"), "").unwrap();
        let start = std::time::Instant::now();
        assert_eq!(read_with(Some(&d.join("tailscale")), Duration::from_millis(300), CAP), Tailscale::SignedOut);
        assert!(start.elapsed() < Duration::from_secs(3), "{:?}", start.elapsed());
        assert_eq!(only_status_was_run(&d), 1);
        let _ = std::fs::remove_dir_all(&d);

        // an answer past the cap is never read as ready, though it would be one under the cap
        let big = with(ready_answer(), |v| v["Health"] = json!(["a".repeat(4000)]));
        let d = stub("big", &big);
        assert_eq!(read_with(Some(&d.join("tailscale")), LIMIT, 2048), Tailscale::SignedOut);
        assert_eq!(read_with(Some(&d.join("tailscale")), LIMIT, big.len() as u64), ready(), "exactly the cap is read");
        assert_eq!(read_with(Some(&d.join("tailscale")), LIMIT, big.len() as u64 - 1), Tailscale::SignedOut, "one byte past it is not");
        assert_eq!(only_status_was_run(&d), 3);
        let _ = std::fs::remove_dir_all(&d);

        // a program that cannot start
        let d = std::env::temp_dir().join(format!("manut-ts-noexec-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("tailscale"), "#!/bin/sh\necho {}\n").unwrap();
        assert_eq!(read_with(Some(&d.join("tailscale")), LIMIT, CAP), Tailscale::SignedOut);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The real read on this computer: `cargo test tailscale::tests::real_state -- --ignored --nocapture`. Prints the
    /// state word only, never the name. It runs `tailscale status --json --peers=false` and nothing else.
    #[test]
    #[ignore]
    fn real_state() {
        let s = read();
        println!("tailscale: {}", serde_json::to_value(&s).unwrap()["state"]);
    }
}
