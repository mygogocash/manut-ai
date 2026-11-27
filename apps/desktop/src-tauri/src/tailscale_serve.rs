//! The one place Manut AI changes the person's Tailscale settings (item 78f, docs/remote-access.md, "The second road:
//! Tailscale"): it puts this Mac's door (`remote_door.rs`, listening on 127.0.0.1 only) behind `tailscale serve` on one
//! port under the Mac's own HTTPS name, and takes it away again. Nothing else of the person's Tailscale setup is touched:
//! never `serve reset` (which would remove the person's own serve entries; this Mac has one on 443), never a port another
//! entry holds, and never a port Funnel can make public.
//!
//! Exactly three commands are ever run, each the person's own CLI found as `tailscale.rs` finds it, with no shell, at most
//! 5 seconds and 1 MiB read (tasks.rs's runner):
//!
//! - `serve status --json`, read for one port only: free, ours (HTTPS, and `/` proxied to `http://127.0.0.1:<port>` and
//!   nothing else), or someone else's;
//! - `serve --bg --yes --https=<port> http://127.0.0.1:<port>`, run only when that port is free (the caller has checked that
//!   Tailscale is ready, HTTPS certificates on, since `serve` would otherwise send the person to a page to turn them on);
//! - `serve --yes --https=<port> off`, run only when that port is ours.
//!
//! Each change is read back with `serve status --json`; an answer this module does not understand is someone else's, so it
//! changes nothing. The flags were read in `tailscale serve --help` on Tailscale 1.104.7. Not tried on a real tailnet before
//! this was written: that `off` removes the entry (it is Tailscale's documented way, not in that help), and what `status
//! --json` prints with no serve entry at all (read as free when it is empty or `{}`).
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::tasks::run_capped;
use crate::tailscale::{locate, CAP, KNOWN, LIMIT};

/// The door's port, on 127.0.0.1 and under the Mac's tailnet name alike. One fixed number, so the phone page's content
/// policy can name it (`wss://*.ts.net:47100`) and nothing wider. Not 443, 8443 or 10000, the only ports Funnel can make
/// public: serve and Funnel share one setting a port, so on this port the door can never become public by a slip.
pub const DOOR_PORT: u16 = 47100;

/// The ports Funnel can make public, never used for the door.
pub const FUNNEL_PORTS: [u16; 3] = [443, 8443, 10000];

/// Where a port stands in the person's serve settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Served {
    /// Nothing is served there.
    Free,
    /// HTTPS there proxies `/` to the door on 127.0.0.1 and does nothing else.
    Ours,
    /// Something else, or an answer that is not understood: left alone.
    Other,
}

/// Whether `port` may carry the door: not a privileged port, and never one Funnel can make public.
pub fn port_ok(port: u16) -> bool {
    port >= 1024 && !FUNNEL_PORTS.contains(&port)
}

/// The proxy target a door on `port` is served as.
fn target(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Where `port` stands in `serve status --json`'s answer: `TCP.<port>` and the `Web` entry named `<host>:<port>` (field
/// names read on 1.104.7's answer). Ours only when the TCP entry is exactly `{"HTTPS": true}` and the one Web entry's only
/// handler is `/` with only `Proxy` set to the door; anything else on that port is someone else's.
pub fn served(answer: &str, port: u16) -> Served {
    let trimmed = answer.trim();
    if trimmed.is_empty() {
        return Served::Free;
    }
    let Ok(v) = serde_json::from_str::<Value>(trimmed) else { return Served::Other };
    let Some(all) = v.as_object() else { return Served::Other };
    let key = port.to_string();
    let tcp = all.get("TCP").and_then(|t| t.get(&key));
    let webs: Vec<&Value> = all
        .get("Web")
        .and_then(Value::as_object)
        .map(|m| m.iter().filter(|(k, _)| k.rsplit_once(':').is_some_and(|(_, p)| p == key)).map(|(_, x)| x).collect())
        .unwrap_or_default();
    let Some(tcp) = tcp else {
        return if webs.is_empty() { Served::Free } else { Served::Other };
    };
    let https_only = tcp.as_object().is_some_and(|o| o.len() == 1 && o.get("HTTPS").and_then(Value::as_bool) == Some(true));
    let want = target(port);
    let proxy_only = |web: &Value| -> bool {
        let Some(h) = web.as_object().filter(|o| o.len() == 1).and_then(|o| o.get("Handlers")).and_then(Value::as_object) else { return false };
        h.len() == 1 && h.get("/").and_then(Value::as_object).is_some_and(|r| r.len() == 1 && r.get("Proxy").and_then(Value::as_str) == Some(want.as_str()))
    };
    if https_only && webs.len() == 1 && proxy_only(webs[0]) {
        Served::Ours
    } else {
        Served::Other
    }
}

/// The argv that serves the door on `port`.
pub fn on_argv(port: u16) -> Vec<String> {
    vec!["serve".into(), "--bg".into(), "--yes".into(), format!("--https={port}"), target(port)]
}

/// The argv that takes the door's entry on `port` away, and only that entry.
pub fn off_argv(port: u16) -> Vec<String> {
    vec!["serve".into(), "--yes".into(), format!("--https={port}"), "off".into()]
}

pub const STATUS_ARGV: [&str; 3] = ["serve", "status", "--json"];

/// Runs the CLI at `exe` with `argv`; its answer when it exited with 0 within the cap. Errors carry no part of the answer.
fn run(exe: &Path, argv: &[String], limit: Duration) -> Result<String, String> {
    match run_capped(exe, argv, limit, CAP.saturating_add(1)) {
        Ok(ran) if ran.code == Some(0) && (ran.out.len() as u64) <= CAP => Ok(ran.out),
        Ok(_) => Err("Tailscale did not do it".into()),
        Err(_) => Err("Tailscale could not be run".into()),
    }
}

fn status(exe: &Path, port: u16, limit: Duration) -> Result<Served, String> {
    let argv: Vec<String> = STATUS_ARGV.iter().map(|a| a.to_string()).collect();
    Ok(served(&run(exe, &argv, limit)?, port))
}

/// Serves the door on `port` through the CLI at `exe`: nothing when it is already ours, a refusal when anything else holds
/// the port, else the one `serve` command, read back. The caller has checked that Tailscale is ready.
pub fn serve_on_with(exe: Option<&Path>, port: u16, limit: Duration) -> Result<(), String> {
    if !port_ok(port) {
        return Err("that port is not one the door may use".into());
    }
    let exe = exe.ok_or("Tailscale isn't installed")?;
    match status(exe, port, limit)? {
        Served::Ours => return Ok(()),
        Served::Other => return Err(format!("Tailscale already serves something else on port {port}, so Manut AI left it as it is")),
        Served::Free => {}
    }
    run(exe, &on_argv(port), limit)?;
    match status(exe, port, limit)? {
        Served::Ours => Ok(()),
        _ => Err("Tailscale did not serve the door".into()),
    }
}

/// Takes the door's entry on `port` away through the CLI at `exe`: nothing when the port is free, a refusal when it holds
/// something that is not the door, else the one `off` command, read back.
pub fn serve_off_with(exe: Option<&Path>, port: u16, limit: Duration) -> Result<(), String> {
    let exe = exe.ok_or("Tailscale isn't installed")?;
    match status(exe, port, limit)? {
        Served::Free => return Ok(()),
        Served::Other => return Err(format!("port {port} serves something that is not Manut AI's door, so it was left as it is")),
        Served::Ours => {}
    }
    run(exe, &off_argv(port), limit)?;
    match status(exe, port, limit)? {
        Served::Free => Ok(()),
        _ => Err("Tailscale still serves the door".into()),
    }
}

/// The person's own CLI, found as `tailscale.rs` finds it.
pub fn cli() -> Option<PathBuf> {
    let known: Vec<PathBuf> = KNOWN.iter().map(PathBuf::from).collect();
    locate(std::env::var_os("PATH").as_deref(), &known, crate::sessions::is_program_file)
}

pub fn serve_on(port: u16) -> Result<(), String> {
    serve_on_with(cli().as_deref(), port, LIMIT)
}

pub fn serve_off(port: u16) -> Result<(), String> {
    serve_off_with(cli().as_deref(), port, LIMIT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ours(port: u16) -> Value {
        json!({"TCP": {port.to_string(): {"HTTPS": true}}, "Web": {format!("mac.tail1234.ts.net:{port}"): {"Handlers": {"/": {"Proxy": format!("http://127.0.0.1:{port}")}}}}})
    }

    /// The person's own entry on 443, as this Mac has one, which nothing here may touch.
    fn theirs() -> Value {
        json!({"TCP": {"443": {"HTTPS": true}}, "Web": {"mac.tail1234.ts.net:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:3773"}}}}})
    }

    #[test]
    fn never_a_port_funnel_can_make_public() {
        assert!(port_ok(DOOR_PORT));
        for p in [443, 8443, 10000, 80, 0] {
            assert!(!port_ok(p), "{p}");
        }
    }

    #[test]
    fn a_port_is_ours_only_when_it_is_exactly_the_door() {
        let p = DOOR_PORT;
        assert_eq!(served("", p), Served::Free);
        assert_eq!(served("{}", p), Served::Free);
        assert_eq!(served(&theirs().to_string(), p), Served::Free);
        assert_eq!(served(&ours(p).to_string(), p), Served::Ours);
        let mut both = theirs();
        both["TCP"][p.to_string()] = json!({"HTTPS": true});
        both["Web"][format!("mac.tail1234.ts.net:{p}")] = ours(p)["Web"][format!("mac.tail1234.ts.net:{p}")].clone();
        assert_eq!(served(&both.to_string(), p), Served::Ours);
        // anything more or other on that port is someone else's
        let mut v = ours(p);
        v["Web"][format!("mac.tail1234.ts.net:{p}")]["Handlers"]["/"]["Proxy"] = json!("http://127.0.0.1:3000");
        assert_eq!(served(&v.to_string(), p), Served::Other);
        let mut v = ours(p);
        v["Web"][format!("mac.tail1234.ts.net:{p}")]["Handlers"]["/admin"] = json!({"Path": "/etc"});
        assert_eq!(served(&v.to_string(), p), Served::Other);
        let mut v = ours(p);
        v["TCP"][p.to_string()] = json!({"HTTPS": true, "TCPForward": "127.0.0.1:22"});
        assert_eq!(served(&v.to_string(), p), Served::Other);
        assert_eq!(served(&json!({"TCP": {p.to_string(): {"TCPForward": "127.0.0.1:22"}}}).to_string(), p), Served::Other);
        assert_eq!(served(&json!({"Web": {format!("x:{p}"): {}}}).to_string(), p), Served::Other);
        assert_eq!(served("No serve config", p), Served::Other);
        assert_eq!(served("[1]", p), Served::Other);
    }

    #[test]
    fn the_commands_are_exactly_these() {
        assert_eq!(on_argv(47100), ["serve", "--bg", "--yes", "--https=47100", "http://127.0.0.1:47100"]);
        assert_eq!(off_argv(47100), ["serve", "--yes", "--https=47100", "off"]);
    }

    /// A stand-in `tailscale` that keeps a serve setting in `now.json`: `status` prints it, the `--bg` command writes
    /// `on.json` there, `off` writes `off.json`, and every call is logged one line each.
    #[cfg(unix)]
    fn stub(tag: &str, now: &Value, on: &Value, off: &Value) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let d = std::env::temp_dir().join(format!("manut-serve-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let script = r#"#!/bin/sh
dir="$(dirname "$0")"
for a in "$@"; do printf '[%s]' "$a" >> "$dir/calls.log"; done
echo >> "$dir/calls.log"
case "$*" in
  "serve status --json") cat "$dir/now.json" ;;
  *--bg*) cp "$dir/on.json" "$dir/now.json" ;;
  *" off") cp "$dir/off.json" "$dir/now.json" ;;
  *) exit 2 ;;
esac
"#;
        std::fs::write(d.join("tailscale"), script).unwrap();
        std::fs::set_permissions(d.join("tailscale"), std::fs::Permissions::from_mode(0o755)).unwrap();
        for (f, v) in [("now.json", now), ("on.json", on), ("off.json", off)] {
            std::fs::write(d.join(f), v.to_string()).unwrap();
        }
        d
    }

    #[cfg(unix)]
    fn calls(d: &Path) -> Vec<String> {
        std::fs::read_to_string(d.join("calls.log")).unwrap_or_default().lines().map(str::to_string).collect()
    }

    const STATUS: &str = "[serve][status][--json]";

    #[cfg(unix)]
    #[test]
    fn serving_adds_only_the_doors_entry_beside_the_persons_own_and_reads_it_back() {
        let p = DOOR_PORT;
        let mut with_door = theirs();
        with_door["TCP"][p.to_string()] = json!({"HTTPS": true});
        with_door["Web"][format!("mac.tail1234.ts.net:{p}")] = ours(p)["Web"][format!("mac.tail1234.ts.net:{p}")].clone();
        let d = stub("on", &theirs(), &with_door, &theirs());
        let exe = d.join("tailscale");
        serve_on_with(Some(&exe), p, LIMIT).unwrap();
        assert_eq!(calls(&d), [STATUS, "[serve][--bg][--yes][--https=47100][http://127.0.0.1:47100]", STATUS]);
        // already ours: nothing is run but the read
        serve_on_with(Some(&exe), p, LIMIT).unwrap();
        assert_eq!(calls(&d).len(), 4);
        // off takes only the door's entry away, and is read back
        serve_off_with(Some(&exe), p, LIMIT).unwrap();
        assert_eq!(&calls(&d)[4..], [STATUS, "[serve][--yes][--https=47100][off]", STATUS]);
        assert_eq!(served(&std::fs::read_to_string(d.join("now.json")).unwrap(), 443), Served::Other, "the person's own entry is still there");
        // free: off runs nothing but the read
        serve_off_with(Some(&exe), p, LIMIT).unwrap();
        assert_eq!(calls(&d).len(), 8);
        assert!(calls(&d).iter().all(|c| !c.contains("reset")));
        let _ = std::fs::remove_dir_all(d);
    }

    #[cfg(unix)]
    #[test]
    fn a_port_someone_else_serves_is_left_alone_both_ways() {
        let p = DOOR_PORT;
        let other = json!({"TCP": {p.to_string(): {"TCPForward": "127.0.0.1:22"}}});
        let d = stub("other", &other, &ours(p), &json!({}));
        let exe = d.join("tailscale");
        assert!(serve_on_with(Some(&exe), p, LIMIT).unwrap_err().contains("something else"));
        assert!(serve_off_with(Some(&exe), p, LIMIT).unwrap_err().contains("not Manut AI's door"));
        assert_eq!(calls(&d), [STATUS, STATUS]);
        let _ = std::fs::remove_dir_all(d);
    }

    #[cfg(unix)]
    #[test]
    fn a_serve_that_does_not_take_is_said_and_nothing_else_is_run() {
        let p = DOOR_PORT;
        // the --bg command "succeeds" but the setting does not change
        let d = stub("nottaken", &json!({}), &json!({}), &json!({}));
        let exe = d.join("tailscale");
        assert_eq!(serve_on_with(Some(&exe), p, LIMIT).unwrap_err(), "Tailscale did not serve the door");
        assert_eq!(calls(&d).len(), 3);
        assert_eq!(serve_on_with(None, p, LIMIT).unwrap_err(), "Tailscale isn't installed");
        assert_eq!(serve_on_with(Some(&exe), 443, LIMIT).unwrap_err(), "that port is not one the door may use");
        assert_eq!(calls(&d).len(), 3, "a Funnel port runs nothing at all");
        let _ = std::fs::remove_dir_all(d);
    }
}
