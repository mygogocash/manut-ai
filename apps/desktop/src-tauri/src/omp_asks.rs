//! oh-my-pi held to asking first as the app's chat (item 139, the sixth security read's H1).
//!
//! omp 18.22.0 defaults its own `tools.approvalMode` to `yolo`, so a chat started with `--mode rpc` alone ran every command,
//! write and edit with no card, in every lane the app makes. Three things now hold an omp chat to the cards, each read in
//! omp itself: its `--help`, `omp config list --json --scope=…` in scratch folders on this Mac, and its source at tag
//! v18.22.0 (commit 3e8cff3, `packages/coding-agent/src`).
//!
//! - Its asking mode on its command line ([`crate::sessions::OMP_CHAT_ARGS`]), a runtime override no settings layer outranks.
//! - An overlay of the app's own, loaded with `--config` ([`OVERLAY`]), that denies omp's `task` tool. omp runs the helpers a
//!   `task` call starts in `yolo` ("Subagents run headless … Use yolo mode to preserve unattended subagent execution", its
//!   `task/executor.ts`), so one card the person allowed let a helper run every command and change after it with no card,
//!   while the chat says every step asks. A `--config` overlay outranks the project's settings and the person's own
//!   (`Settings.getProvenance`), and a `deny` policy wins in every mode (`tools/approval.ts`, `resolvePolicy`); with omp
//!   itself, an overlay's `task: deny` beside a project's `task: allow` reads as `deny`.
//! - Its own settings, read before the start ([`settings_allow`]). A per-tool `tools.approval` policy of `allow` is
//!   "honored in every approval mode" (its own description of the setting), so one in the person's settings or in the
//!   project's would run that tool with no card. omp merges its project layer from the chat's folder alone, out of seven
//!   kinds of file in six tools' folders and four formats (`.omp/config.yml`, `.omp/settings.json`, `.claude/settings.json`,
//!   `.codex/config.toml`, `.cursor/settings.json`, `.gemini/settings.json`, `opencode.json(c)` and
//!   `.opencode/opencode.json(c)`: each set a `tools.approval` entry that omp listed, in a scratch folder here), and its
//!   global layer from the `config.yml` of the agent folder its profile and variables pick. So the shell does not read
//!   those files itself, which could miss one or read one differently: it asks omp, in the chat's folder and with the
//!   chat's variables, for the keys each layer sets as written (`omp config list --json --scope=global|project`, which omp
//!   added "so a host can edit the global value"), as OpenCode's rules are read from its own listing.
//!
//! omp has no switch that leaves out the project layer: its `disabledProviders` setting drops whole tools' folders, the
//! person's own with them, and never `.omp`. So the project's settings are checked, not left out. A change the agent makes
//! to one of these files during the chat asks at every level (`.omp`, `.claude`, `.codex`, `.cursor`, `.gemini`,
//! `opencode.json` and `.opencode` are in `src/code/command/protected.ts`), and omp's own folder is outside the project.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// The overlay's text: omp's `task` tool denied, the one setting it holds. YAML, as omp reads a `--config` file.
pub const OVERLAY: &str = "# Manut AI: oh-my-pi runs the helpers a task call starts without asking, so its chats in Manut AI deny that tool.\ntools:\n  approval:\n    task: deny\n";

/// `<home>/.manut/omp/asks.yml`, the one file Manut AI writes for oh-my-pi.
pub fn overlay_path(home: &Path) -> PathBuf {
    home.join(".manut").join("omp").join("asks.yml")
}

/// Write [`OVERLAY`] to `path` unless it already holds exactly that, as DSH's overlay is written. A link in its place or
/// in place of its folder is refused: the chat then does not start, since without it a helper would run unasked.
pub fn write_overlay(path: &Path) -> Result<(), String> {
    if path.is_symlink() || path.parent().is_some_and(Path::is_symlink) {
        return Err(format!("{} is a link; Manut AI does not write through it", path.display()));
    }
    if std::fs::read_to_string(path).is_ok_and(|t| t == OVERLAY) {
        return Ok(());
    }
    std::fs::create_dir_all(path.parent().ok_or("no folder")?).map_err(|e| e.to_string())?;
    std::fs::write(path, OVERLAY).map_err(|e| e.to_string())
}

/// The arguments that load the overlay at `path`: `--config` and the path as one argument. A Windows `.cmd` shim runs
/// through `cmd.exe /c`, which parses the line itself, so there the path goes in as [`crate::sessions::cmd_path_arg`]
/// allows it, and one it refuses refuses the start.
pub fn overlay_args(path: &Path, through_cmd: bool) -> Result<Vec<OsString>, String> {
    let arg = if through_cmd { OsString::from(crate::sessions::cmd_path_arg(&path.to_string_lossy())?) } else { path.as_os_str().to_owned() };
    Ok(vec!["--config".into(), arg])
}

/// The variable omp reads more overlay files from (`PI_CONFIG_FILES`, its `config/settings.ts`). A layer's listing does
/// not show what such a file sets, so a chat does not start while it is set (the person's own variables on Settings ›
/// Providers already refuse it).
pub const OVERLAYS_VAR: &str = "PI_CONFIG_FILES";

/// The approval modes in which omp asks before a write and before a command (its settings table: `always-ask`, and
/// `always-ask-cached`, which also asks before a read). `write` lets every write tool run alone and `yolo` every tool.
pub const ASKING: [&str; 2] = ["always-ask", "always-ask-cached"];

/// The two listings, each the keys one layer sets with their values as written: the person's own (`global`, the
/// `config.yml` of the agent folder) and the project's (`project`, the chat's folder).
pub const LISTINGS: [[&str; 4]; 2] = [["config", "list", "--json", "--scope=global"], ["config", "list", "--json", "--scope=project"]];

/// What one layer's listing (a JSON object of setting ids, each `{ value, type, description }`) says. `Some(true)`: it
/// leaves omp asking, since `tools.approvalMode`, when the layer sets it, is one of [`ASKING`], and every `tools.approval`
/// policy it sets is `prompt` or `deny`, compared as omp compares them (blanks trimmed, any case). `Some(false)`: it sets
/// anything else there (another mode or policy, or a value of another kind, which omp would read as no policy or as
/// `yolo`; a value it might read differently is not taken as safe). `None`: it is not a listing (not such an object, or one
/// of the two entries has no value, as only a credential's would). A `null` is a value omp counts as unset, so the mode on
/// the command line applies to it as to an absent one.
pub fn layer_asks(listing: &str) -> Option<bool> {
    let Ok(Value::Object(keys)) = serde_json::from_str::<Value>(listing.trim()) else { return None };
    let set = |id: &str| -> Option<Option<&Value>> { keys.get(id).map(|entry| entry.get("value")) };
    let (Some(mode), Some(policies)) = (set("tools.approvalMode").unwrap_or(Some(&Value::Null)), set("tools.approval").unwrap_or(Some(&Value::Null))) else {
        return None;
    };
    let mode_asks = match mode {
        Value::Null => true,
        Value::String(m) => ASKING.contains(&m.as_str()),
        _ => false,
    };
    let policies_ask = match policies {
        Value::Null => true,
        Value::Object(each) => each.values().all(|p| matches!(p, Value::String(s) if matches!(s.trim().to_lowercase().as_str(), "prompt" | "deny"))),
        _ => false,
    };
    Some(mode_asks && policies_ask)
}

/// Why an omp chat did not start when its settings could not be checked: a listing failed, ran out of time or printed
/// something else, or [`OVERLAYS_VAR`] is set (the UI shows it translated, `ss.noAsksCheck`).
pub fn no_check(label: &str) -> String {
    format!("{label} did not start because Manut AI could not check that its own settings make it ask first.")
}

/// Whether an omp chat may start as far as its own settings say: `overlays` is [`OVERLAYS_VAR`]'s value in the chat's
/// variables (then the app's), and `list` runs omp with one of [`LISTINGS`] in the chat's folder with the chat's
/// variables, giving what it printed when it ended well. A layer that would let a tool run unasked refuses with
/// [`crate::acp_chat::no_asks`]; any doubt refuses with [`no_check`]. Nothing is started either way.
pub fn settings_allow(label: &str, overlays: Option<&str>, list: &dyn Fn(&[&str]) -> Option<String>) -> Result<(), String> {
    if overlays.is_some_and(|v| !v.trim().is_empty()) {
        return Err(no_check(label));
    }
    for args in LISTINGS {
        match list(&args).as_deref().map(layer_asks) {
            Some(Some(true)) => {}
            Some(Some(false)) => return Err(crate::acp_chat::no_asks(label)),
            Some(None) | None => return Err(no_check(label)),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// One layer's listing as omp prints it, with these setting ids and values.
    fn listing(entries: &[(&str, Value)]) -> String {
        let mut o = serde_json::Map::new();
        for (id, v) in entries {
            o.insert(id.to_string(), serde_json::json!({ "value": v, "type": "x", "description": "y" }));
        }
        Value::Object(o).to_string()
    }

    /// A layer that sets neither key, or sets them to ask, leaves omp asking; any mode or policy that lets a tool run unasked,
    /// any value of another kind, and any text that is not a listing refuses.
    #[test]
    fn only_a_layer_that_keeps_omp_asking_passes() {
        use serde_json::json;
        // omp 18.22.0's own words on this Mac for a layer with no such key (the five keys the person's config sets)
        let own = r#"{"composer.shape":{"value":"round","type":"enum","description":"x"},"setupVersion":{"value":3,"type":"number","description":"x"}}"#;
        for ok in [
            "{}".to_string(),
            own.to_string(),
            listing(&[("tools.approvalMode", json!("always-ask"))]),
            listing(&[("tools.approvalMode", json!("always-ask-cached"))]),
            listing(&[("tools.approvalMode", json!(null))]),
            listing(&[("tools.approval", json!({}))]),
            listing(&[("tools.approval", json!(null))]),
            listing(&[("tools.approval", json!({"bash": "prompt", "edit": "deny", "computer.control": " DENY ", "write": "Prompt"}))]),
            listing(&[("tools.approvalMode", json!("always-ask")), ("tools.approval", json!({"task": "deny"})), ("theme.dark", json!("titanium"))]),
        ] {
            assert_eq!(layer_asks(&ok), Some(true), "{ok}");
        }
        for unsafe_layer in [
            listing(&[("tools.approvalMode", json!("yolo"))]),
            listing(&[("tools.approvalMode", json!("write"))]),
            listing(&[("tools.approvalMode", json!("ALWAYS-ASK"))]),
            listing(&[("tools.approvalMode", json!("always-ask "))]),
            listing(&[("tools.approvalMode", json!(true))]),
            listing(&[("tools.approvalMode", json!(["always-ask"]))]),
            listing(&[("tools.approval", json!({"bash": "allow"}))]),
            listing(&[("tools.approval", json!({"edit": "ALLOW"}))]),
            listing(&[("tools.approval", json!({"write": " allow "}))]),
            listing(&[("tools.approval", json!({"computer.control": "allow"}))]),
            listing(&[("tools.approval", json!({"bash": "prompt", "task": "allow"}))]),
            listing(&[("tools.approval", json!({"bash": true}))]),
            listing(&[("tools.approval", json!({"bash": {"policy": "prompt"}}))]),
            listing(&[("tools.approval", json!({"bash": ""}))]),
            listing(&[("tools.approval", json!("allow"))]),
            listing(&[("tools.approval", json!(["bash"]))]),
            listing(&[("tools.approvalMode", json!("always-ask")), ("tools.approval", json!({"eval": "allow"}))]),
        ] {
            assert_eq!(layer_asks(&unsafe_layer), Some(false), "{unsafe_layer}");
        }
        for unread in [
            // an entry with no value (as a credential's is listed), or one that is not an entry, cannot be checked
            r#"{"tools.approval":{"redacted":true,"type":"record","description":"x"}}"#.to_string(),
            r#"{"tools.approvalMode":"yolo"}"#.to_string(),
            "[]".to_string(),
            "".to_string(),
            "not json".to_string(),
            "Settings in the project layer:\n  tools.approvalMode = always-ask".to_string(),
        ] {
            assert_eq!(layer_asks(&unread), None, "{unread}");
        }
    }

    /// Both layers are listed, each with its own scope; an unsafe one refuses with the settings sentence and a missing or
    /// unreadable listing with the could-not-check sentence, and an overlay variable refuses before omp is run at all.
    #[test]
    fn settings_allow_lists_both_layers_and_refuses_each_unsafe_one() {
        use serde_json::json;
        let safe = listing(&[("tools.approvalMode", json!("always-ask"))]);
        let yolo = listing(&[("tools.approvalMode", json!("yolo"))]);
        let allow = listing(&[("tools.approval", json!({"bash": "allow"}))]);
        let run = |global: Option<&str>, project: Option<&str>, overlays: Option<&str>| {
            let asked = RefCell::new(Vec::new());
            let got = settings_allow("oh-my-pi", overlays, &|args: &[&str]| {
                asked.borrow_mut().push(args.join(" "));
                match args.last() {
                    Some(&"--scope=global") => global.map(str::to_string),
                    Some(&"--scope=project") => project.map(str::to_string),
                    _ => None,
                }
            });
            (got, asked.into_inner())
        };
        let refused = crate::acp_chat::no_asks("oh-my-pi");
        let unchecked = no_check("oh-my-pi");
        let (got, asked) = run(Some(&safe), Some("{}"), None);
        assert_eq!(got, Ok(()));
        assert_eq!(asked, ["config list --json --scope=global", "config list --json --scope=project"]);
        for (global, project) in [(&yolo, &safe), (&allow, &safe), (&safe, &yolo), (&safe, &allow)] {
            assert_eq!(run(Some(global), Some(project), None).0, Err(refused.clone()), "{global} {project}");
        }
        assert_eq!(run(None, Some(&safe), None).0, Err(unchecked.clone()));
        assert_eq!(run(Some(&safe), None, None).0, Err(unchecked.clone()));
        assert_eq!(run(Some(&safe), Some("garbage"), None).0, Err(unchecked.clone()));
        // the person's own layer is checked first, and an unsafe one stops before the project is listed
        let (got, asked) = run(Some(&yolo), Some(&safe), None);
        assert_eq!((got, asked.len()), (Err(refused), 1));
        let (got, asked) = run(Some(&safe), Some(&safe), Some("/tmp/more.yml"));
        assert_eq!((got, asked.len()), (Err(unchecked), 0));
        assert_eq!(run(Some(&safe), Some(&safe), Some("  ")).0, Ok(()));
        assert_eq!(no_check("oh-my-pi"), "oh-my-pi did not start because Manut AI could not check that its own settings make it ask first.");
    }

    /// The overlay is written once in the app's own folder, with exactly its text, and never through a link.
    #[test]
    fn the_overlay_denies_the_task_tool_and_is_never_written_through_a_link() {
        let dir = std::env::temp_dir().join(format!("manut-omp-overlay-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let p = overlay_path(&dir);
        assert!(p.ends_with(".manut/omp/asks.yml"));
        write_overlay(&p).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), OVERLAY);
        std::fs::write(&p, "tools:\n  approval:\n    task: allow\n").unwrap();
        write_overlay(&p).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), OVERLAY);
        // the one setting it holds, as omp reads YAML: task denied, nothing allowed
        let lines: Vec<&str> = OVERLAY.lines().filter(|l| !l.trim_start().starts_with('#')).collect();
        assert_eq!(lines, ["tools:", "  approval:", "    task: deny"]);
        assert_eq!(overlay_args(&p, false).unwrap(), [OsString::from("--config"), p.as_os_str().to_owned()]);
        #[cfg(unix)]
        {
            let elsewhere = dir.join("elsewhere.yml");
            std::fs::write(&elsewhere, "x").unwrap();
            std::fs::remove_file(&p).unwrap();
            std::os::unix::fs::symlink(&elsewhere, &p).unwrap();
            assert!(write_overlay(&p).is_err());
            assert_eq!(std::fs::read_to_string(&elsewhere).unwrap(), "x");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
