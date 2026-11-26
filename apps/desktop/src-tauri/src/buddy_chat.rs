//! Buddy's chat on this computer: Buddy answers through the coding agent the person already has installed and signed in
//! to, with the person's own account, so Manut AI needs no model key of its own (docs/decisions.md, 25 Nov 2026).
//!
//! Only Claude Code answers as Buddy for now. It runs in its structured chat mode ([`CLAUDE_CHAT_ARGS`]), so every
//! permission it asks comes to the page as a card, through the same Claude adapter the coding sessions use
//! (`crate::agent_chat`), and with the person's normal configuration: their own MCP servers, skills, plugins and
//! settings, read from their own home as a terminal session of Claude Code reads them. What Buddy adds is fixed here:
//!
//! - `--permission-mode default`, the most careful mode the lanes' dial offers: everything that acts (a file changed, a
//!   command run, an MCP tool) asks first. It is named on the command line so a `defaultMode` in the person's own
//!   settings can never start Buddy in a mode that skips the asks. The person's own allow rules still hold, as they do
//!   in a terminal session of theirs.
//! - `--no-session-persistence`: Buddy's chats are not kept in Claude Code's own list of conversations.
//! - `--append-system-prompt-file <file>`: who Buddy is (`buddyPrompt` in packages/agent-prompts), added to Claude
//!   Code's own instructions and never in their place, so its tools and skills work as they always do. The text is the
//!   page's, written to a file under `~/.manut/buddy/prompts` and passed by its path, so no free text from the page ever
//!   becomes a program argument; the file goes when the chat ends.
//!
//! Each chat runs in `~/.manut/buddy/chat`, an empty folder of Buddy's own and never a project. Buddy's chats are kept
//! apart from the coding sessions' (their own [`ChatSessions`] in the shell), so a coding session's reset never stops
//! one, and the page can send them only what a conversation needs ([`check`]): a message, Stop, an answer, and the
//! chat box's three choices, each checked here against a list the page cannot add to. The approval level is one of
//! [`BUDDY_MODES`], the effort one of Claude Code's own levels, and the model one Claude Code itself listed in that very
//! process.
//!
//! A file the person attaches is saved by the shell under `~/.manut/buddy/files` ([`save_file`]), outside Buddy's folder,
//! and named in the message by its path; a folder is named by its path and never copied. Claude Code reads neither
//! without asking first, since both are outside the folder it runs in.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime};

use crate::agent_chat::{ChatOut, ChatSessions, Input, CLAUDE_EFFORTS};
use crate::session_files;
use crate::sessions::{cmd_path_arg, CLAUDE_CHAT_ARGS};

/// The agents that may answer as Buddy. Codex, OmO and the others are not offered yet: Buddy's asks and its fixed start
/// were checked against Claude Code only.
pub const BUDDY_AGENTS: [&str; 1] = ["claude"];

/// Buddy's own arguments, after Claude Code's chat-mode ones and before its instructions file.
pub const BUDDY_CLAUDE_ARGS: [&str; 3] = ["--permission-mode", "default", "--no-session-persistence"];

/// The approval levels the page may choose for Buddy's chat, as Claude Code's own permission modes: `default`, where
/// everything that acts asks first (Buddy starts in it, [`BUDDY_CLAUDE_ARGS`]), and `plan`, where Claude Code says what
/// it would do and changes nothing until the person says yes to the plan, which takes it back to `default`. Never
/// `acceptEdits`, which changes files unasked in a folder the person names and leaves Buddy nothing to undo it with,
/// and never a mode that skips the asks (`bypassPermissions`, `dontAsk`, `auto`).
pub const BUDDY_MODES: [&str; 2] = ["default", "plan"];

/// The longest instructions the page may hand over (`BUDDY_PROMPT_CHARS` in packages/agent-prompts).
pub const PROMPT_CHARS: usize = 16_000;

/// How old a left-over instructions file must be before a new start clears it away (one whose chat ended without the
/// shell seeing it, as after a crash).
const STALE_PROMPT: Duration = Duration::from_secs(24 * 60 * 60);

/// `~/.manut/buddy`.
pub fn buddy_dir(home: &Path) -> PathBuf {
    home.join(".manut").join("buddy")
}

/// The folder Buddy's chats run in: `~/.manut/buddy/chat`, made when missing. Nothing is ever written there by manut.
pub fn chat_dir(home: &Path) -> Result<PathBuf, String> {
    let dir = buddy_dir(home).join("chat");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not make Buddy's folder: {e}"))?;
    Ok(dir)
}

/// Buddy's instructions as the page sent them, refused when empty, too long or holding a NUL.
pub fn check_prompt(prompt: &str) -> Result<(), String> {
    if prompt.trim().is_empty() {
        return Err("Buddy's instructions are empty".into());
    }
    if prompt.chars().count() > PROMPT_CHARS {
        return Err(format!("Buddy's instructions are longer than {PROMPT_CHARS} characters"));
    }
    if prompt.contains('\0') {
        return Err("Buddy's instructions hold a character that cannot be written".into());
    }
    Ok(())
}

/// Whether `agent` may answer as Buddy.
pub fn may_answer(agent: &str) -> bool {
    BUDDY_AGENTS.contains(&agent)
}

/// What the page may send Buddy's chat: a message (text only: an attached file goes by its path in the text), Stop, the
/// answer to an ask or a question, and the chat box's choices: an approval level of [`BUDDY_MODES`], an effort of
/// Claude Code's own levels ([`CLAUDE_EFFORTS`]), and a model, which [`check`] holds to the ones Claude Code listed.
/// Never a rewind, a steer or a picture as the agent's image input.
pub fn allowed(input: &Input) -> bool {
    match input {
        Input::Send { images, .. } => images.is_empty(),
        Input::Interrupt | Input::Approve { .. } | Input::Clarify { .. } | Input::Model { .. } => true,
        Input::Mode { mode } => BUDDY_MODES.contains(&mode.as_str()),
        Input::Effort { effort } => CLAUDE_EFFORTS.contains(&effort.as_str()),
        _ => false,
    }
}

/// `input` as the page sent it, checked whole: [`allowed`], and a model only when it is one of `offered`, the values
/// Claude Code itself listed at the start of this chat's process (kept by its adapter in the shell,
/// `ChatSessions::models`). The page never names a model of its own, so before Claude Code has listed any, none is taken.
pub fn check(input: &Input, offered: &[String]) -> Result<(), String> {
    if !allowed(input) {
        return Err("Buddy's chat takes a message, Stop, an answer, or a model, effort or approval level it offers".into());
    }
    if let Input::Model { model } = input {
        if !offered.iter().any(|m| m == model) {
            return Err(format!("{model} is not a model Claude Code offered in this chat"));
        }
    }
    Ok(())
}

/// `~/.manut/buddy/files`: the copies of the files the person attached in Buddy's chats. Outside `chat`, the folder
/// Buddy's agent runs in, so the agent asks before it reads one.
pub fn files_dir(home: &Path) -> PathBuf {
    buddy_dir(home).join("files")
}

/// Saves one file the person attached in Buddy's chat as `~/.manut/buddy/files/<n>-<name>` and returns that path. The
/// name is made safe as a session's attachment's is (`session_files::safe_name`), a copy is never written over, a file
/// over 100 MB and a folder on the way that is a link are refused, and copies older than a day are cleared first, as
/// the instructions files are: each belongs to a conversation that has moved on.
pub fn save_file(home: &Path, name: &str, data: &[u8]) -> Result<PathBuf, String> {
    if data.len() > session_files::MAX_BYTES {
        return Err("over 100 MB".into());
    }
    let dir = files_dir(home);
    for d in [home.join(".manut"), buddy_dir(home), dir.clone()] {
        if d.is_symlink() {
            return Err(format!("{} is a link", d.display()));
        }
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not make Buddy's folder: {e}"))?;
    if let Ok(list) = std::fs::read_dir(&dir) {
        for f in list.flatten() {
            let old = f.metadata().and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok()).is_some_and(|age| age > STALE_PROMPT);
            if old && f.file_type().is_ok_and(|t| t.is_file()) {
                let _ = std::fs::remove_file(f.path());
            }
        }
    }
    let name = session_files::safe_name(name);
    for n in 1..10_000u32 {
        let path = dir.join(format!("{n}-{name}"));
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                use std::io::Write;
                f.write_all(data).map_err(|e| e.to_string())?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("too many files in Buddy's folder".into())
}

static PROMPT_SEQ: AtomicU32 = AtomicU32::new(0);

/// Writes `prompt` to a new file under `~/.manut/buddy/prompts` and returns its path. Files there older than a day are
/// cleared first: each belongs to a chat that ended without the shell removing it.
pub fn write_prompt(home: &Path, prompt: &str) -> Result<PathBuf, String> {
    check_prompt(prompt)?;
    let dir = buddy_dir(home).join("prompts");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not make Buddy's folder: {e}"))?;
    if let Ok(list) = std::fs::read_dir(&dir) {
        for f in list.flatten() {
            let old = f.metadata().and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok()).is_some_and(|age| age > STALE_PROMPT);
            if old && f.path().extension().is_some_and(|x| x == "md") {
                let _ = std::fs::remove_file(f.path());
            }
        }
    }
    let nanos = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let path = dir.join(format!("{nanos}-{}-{}.md", std::process::id(), PROMPT_SEQ.fetch_add(1, Ordering::SeqCst)));
    std::fs::write(&path, prompt).map_err(|e| format!("could not write Buddy's instructions: {e}"))?;
    Ok(path)
}

/// Claude Code's whole command line as Buddy: the program as it is launched (`launch`, from the allow-list), its chat
/// mode, Buddy's fixed arguments and the instructions file. On Windows a `.cmd` shim runs through `cmd.exe /c`, which
/// reads the line itself, so the file's path goes through [`cmd_path_arg`] there, and a path it refuses refuses the start.
pub fn claude_argv(launch: Vec<OsString>, prompt_file: &Path) -> Result<Vec<OsString>, String> {
    let mut argv = launch;
    let through_cmd = argv.first().is_some_and(|p| p == "cmd.exe");
    argv.extend(CLAUDE_CHAT_ARGS.iter().map(OsString::from));
    argv.extend(BUDDY_CLAUDE_ARGS.iter().map(OsString::from));
    argv.push("--append-system-prompt-file".into());
    if through_cmd {
        argv.push(cmd_path_arg(&prompt_file.to_string_lossy())?.into());
    } else {
        argv.push(prompt_file.as_os_str().to_owned());
    }
    Ok(argv)
}

/// Starts Buddy's chat through `agent` with `prompt`, as the account `account_env` names (the one picked for new
/// sessions, else the CLI's own). The instructions file is removed when the chat ends.
pub fn start<F>(chats: &ChatSessions, home: &Path, agent: &str, prompt: &str, account_env: &[(String, String)], mut sink: F) -> Result<u32, String>
where
    F: FnMut(ChatOut) + Send + 'static,
{
    if !may_answer(agent) {
        return Err(format!("{agent} cannot answer as Buddy"));
    }
    let cwd = chat_dir(home)?;
    let file = write_prompt(home, prompt)?;
    let gone = file.clone();
    let started = chats.start_buddy(&cwd, &file, account_env, move |out| {
        if matches!(out, ChatOut::Exit(..)) {
            let _ = std::fs::remove_file(&gone);
        }
        sink(out);
    });
    if started.is_err() {
        let _ = std::fs::remove_file(&file);
    }
    started
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn home(name: &str) -> PathBuf {
        let h = std::env::temp_dir().join(format!("manut-buddy-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&h);
        std::fs::create_dir_all(&h).unwrap();
        h
    }

    #[test]
    fn claude_code_alone_answers_as_buddy() {
        assert!(may_answer("claude"));
        for other in ["codex", "omo", "pi", "omp", "opencode", "dsh", "grok", "omh", "", "claude "] {
            assert!(!may_answer(other), "{other}");
        }
        let c = ChatSessions::default();
        let h = home("refused");
        assert!(start(&c, &h, "codex", "You are Buddy.", &[], |_| {}).unwrap_err().contains("cannot answer as Buddy"));
        // refused before anything is written
        assert!(!buddy_dir(&h).exists());
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn the_command_line_is_the_chat_mode_then_the_careful_mode_then_the_instructions_file() {
        let argv = claude_argv(vec!["/opt/bin/claude".into()], Path::new("/Users/me/.manut/buddy/prompts/1.md")).unwrap();
        let mut want: Vec<&str> = vec!["/opt/bin/claude"];
        want.extend(CLAUDE_CHAT_ARGS);
        want.extend(["--permission-mode", "default", "--no-session-persistence", "--append-system-prompt-file", "/Users/me/.manut/buddy/prompts/1.md"]);
        assert_eq!(argv, want.iter().map(OsString::from).collect::<Vec<_>>());
        // every ask comes to the page, and nothing skips them or replaces Claude Code's own instructions
        assert!(argv.windows(2).any(|w| w[0] == "--permission-prompt-tool" && w[1] == "stdio"));
        for never in ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "bypassPermissions", "acceptEdits", "auto", "dontAsk", "--system-prompt", "--system-prompt-file", "--tools", "--strict-mcp-config", "--safe-mode", "--bare", "--disable-slash-commands"] {
            assert!(!argv.iter().any(|a| a == never), "{never}");
        }
    }

    #[test]
    fn through_cmd_the_file_is_escaped_or_refused() {
        let launch = vec![OsString::from("cmd.exe"), "/c".into(), r"C:\npm\claude.cmd".into()];
        let argv = claude_argv(launch.clone(), Path::new(r"C:\Users\a&b\.manut\buddy\prompts\1.md")).unwrap();
        assert_eq!(argv.last().unwrap(), r"C:\Users\a^&b\.manut\buddy\prompts\1.md");
        assert!(claude_argv(launch, Path::new(r"C:\Users\100%\.manut\buddy\prompts\1.md")).is_err());
    }

    #[test]
    fn instructions_are_checked_and_written_under_buddys_own_folder() {
        assert!(check_prompt("  ").is_err());
        assert!(check_prompt(&"x".repeat(PROMPT_CHARS + 1)).is_err());
        assert!(check_prompt("a\0b").is_err());
        assert!(check_prompt(&"ก".repeat(PROMPT_CHARS)).is_ok(), "counted in characters, not bytes");
        let h = home("write");
        let a = write_prompt(&h, "You are Buddy.").unwrap();
        let b = write_prompt(&h, "You are Buddy, again.").unwrap();
        assert_ne!(a, b, "each chat has its own file");
        assert!(a.starts_with(buddy_dir(&h).join("prompts")));
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "You are Buddy.");
        assert!(write_prompt(&h, "").is_err());
        let dir = chat_dir(&h).unwrap();
        assert_eq!(dir, h.join(".manut").join("buddy").join("chat"));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "Buddy's folder is empty");
        let _ = std::fs::remove_dir_all(h);
    }

    fn input(v: serde_json::Value) -> Input {
        serde_json::from_value::<Input>(v).unwrap()
    }

    /// What Claude Code listed at the start of a chat (`initialize`'s `models[].value`), as its adapter keeps it.
    fn offered() -> Vec<String> {
        ["default", "opus", "sonnet[1m]", "haiku"].map(String::from).to_vec()
    }

    #[test]
    fn the_page_sends_buddy_a_conversation_and_the_boxs_three_choices() {
        let ok = |v: serde_json::Value| check(&input(v), &offered()).is_ok();
        assert!(ok(json!({"kind": "send", "text": "hi"})));
        assert!(ok(json!({"kind": "interrupt"})));
        assert!(ok(json!({"kind": "approve", "request_id": "r1", "choice": "once"})));
        assert!(ok(json!({"kind": "clarify", "request_id": "r1", "answer": "yes"})));
        // the approval levels, both of which ask before anything acts
        assert_eq!(BUDDY_MODES, ["default", "plan"]);
        assert!(ok(json!({"kind": "mode", "mode": "default"})));
        assert!(ok(json!({"kind": "mode", "mode": "plan"})));
        // Claude Code's own effort levels, the same list its adapter sends
        for e in CLAUDE_EFFORTS {
            assert!(ok(json!({"kind": "effort", "effort": e})), "{e}");
        }
        // a model Claude Code itself listed in this chat
        assert!(ok(json!({"kind": "model", "model": "opus"})));
        assert!(ok(json!({"kind": "model", "model": "sonnet[1m]"})));
    }

    #[test]
    fn a_level_that_skips_the_asks_and_anything_else_the_page_names_is_refused() {
        let refused = |v: serde_json::Value| check(&input(v), &offered()).is_err();
        // every mode that skips asking, or changes files unasked, and anything spelled like one
        for mode in ["acceptEdits", "bypassPermissions", "dontAsk", "auto", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "Default", "plan ", "", "default\0"] {
            assert!(refused(json!({"kind": "mode", "mode": mode})), "{mode:?}");
        }
        for effort in ["", "minimal", "ultra", "HIGH", "--max", "max "] {
            assert!(refused(json!({"kind": "effort", "effort": effort})), "{effort:?}");
        }
        // a model the agent did not list, a flag in a model's place, and a near miss of a listed one
        for model in ["opus-5", "--dangerously-skip-permissions", "--model", "", "Opus", "opus ", "sonnet[1m] --bare", "../../bin/sh"] {
            assert!(refused(json!({"kind": "model", "model": model})), "{model:?}");
        }
        // before Claude Code has listed its models, no model is taken at all
        assert!(check(&input(json!({"kind": "model", "model": "opus"})), &[]).is_err());
        // still no picture as the agent's image input, no rewind and no steer
        assert!(refused(json!({"kind": "send", "text": "hi", "images": ["/x.png"]})));
        assert!(refused(json!({"kind": "rewind"})));
        assert!(refused(json!({"kind": "rewind_to", "id": "m1"})));
        assert!(refused(json!({"kind": "steer", "id": "m1", "text": "x"})));
        // and the start never carries a mode of the page's: the fixed arguments stay as they were
        assert_eq!(BUDDY_CLAUDE_ARGS, ["--permission-mode", "default", "--no-session-persistence"]);
    }

    #[test]
    fn a_model_pick_is_checked_against_what_the_running_claude_code_listed() {
        // Claude Code 2.1.323's initialize answer, as the coding sessions' recordings hold it, read by the same adapter
        let mut c = crate::agent_chat::Claude::new("/home/you/.manut/buddy/chat");
        assert!(crate::agent_chat::Adapter::models(&c).is_empty(), "nothing listed before the start");
        let init = json!({"type": "control_response", "response": {"subtype": "success", "request_id": "manut-init-1", "response": {
            "commands": [], "models": [
                {"value": "default", "displayName": "Default (recommended)", "description": "Fable 5.2 · Most capable"},
                {"value": "haiku", "displayName": "Haiku", "description": "Haiku 5.5 · Fastest"}
            ]}}});
        crate::agent_chat::Adapter::on_line(&mut c, &init.to_string());
        let listed = crate::agent_chat::Adapter::models(&c);
        assert_eq!(listed, ["default", "haiku"]);
        assert!(check(&input(json!({"kind": "model", "model": "haiku"})), &listed).is_ok());
        assert!(check(&input(json!({"kind": "model", "model": "opus"})), &listed).is_err());
        // a chat that is gone lists nothing, so no model reaches it
        assert!(ChatSessions::default().models(7).is_empty());
    }

    #[test]
    fn an_attached_file_is_a_copy_under_buddys_own_files_folder_outside_the_folder_it_runs_in() {
        let h = home("files");
        let a = save_file(&h, "../../etc/passwd", b"one").unwrap();
        let b = save_file(&h, "passwd", b"two").unwrap();
        assert_eq!(a, files_dir(&h).join("1-passwd"));
        assert_eq!(b, files_dir(&h).join("2-passwd"), "never written over");
        assert_eq!(std::fs::read(&a).unwrap(), b"one");
        assert_eq!(save_file(&h, "메뉴 사진.png", b"x").unwrap(), files_dir(&h).join("1-메뉴 사진.png"));
        // not in the folder Buddy's agent runs in, which stays empty, so the agent asks before it reads a copy
        let chat = chat_dir(&h).unwrap();
        assert!(!a.starts_with(&chat));
        assert_eq!(std::fs::read_dir(&chat).unwrap().count(), 0);
        assert!(save_file(&h, "big", &vec![0u8; session_files::MAX_BYTES + 1]).is_err());
        #[cfg(unix)]
        {
            let h2 = home("files-link");
            std::fs::create_dir_all(buddy_dir(&h2)).unwrap();
            std::os::unix::fs::symlink(&h2, files_dir(&h2)).unwrap();
            assert!(save_file(&h2, "a.txt", b"x").unwrap_err().contains("is a link"));
            let _ = std::fs::remove_dir_all(h2);
        }
        let _ = std::fs::remove_dir_all(h);
    }
}
