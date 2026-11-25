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
//! one, and the page can send them only what a conversation needs ([`allowed`]).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime};

use crate::agent_chat::{ChatOut, ChatSessions, Input};
use crate::sessions::{cmd_path_arg, CLAUDE_CHAT_ARGS};

/// The agents that may answer as Buddy. Codex, OmO and the others are not offered yet: Buddy's asks and its fixed start
/// were checked against Claude Code only.
pub const BUDDY_AGENTS: [&str; 1] = ["claude"];

/// Buddy's own arguments, after Claude Code's chat-mode ones and before its instructions file.
pub const BUDDY_CLAUDE_ARGS: [&str; 3] = ["--permission-mode", "default", "--no-session-persistence"];

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

/// What the page may send Buddy's chat: a message (text only), Stop, and the answer to an ask or a question. Never a
/// permission mode, a model, a rewind or a picture, which Buddy has no use for.
pub fn allowed(input: &Input) -> bool {
    match input {
        Input::Send { images, .. } => images.is_empty(),
        Input::Interrupt | Input::Approve { .. } | Input::Clarify { .. } => true,
        _ => false,
    }
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

    #[test]
    fn the_page_sends_buddy_only_what_a_conversation_needs() {
        let input = |v: serde_json::Value| serde_json::from_value::<Input>(v).unwrap();
        assert!(allowed(&input(json!({"kind": "send", "text": "hi"}))));
        assert!(allowed(&input(json!({"kind": "interrupt"}))));
        assert!(allowed(&input(json!({"kind": "approve", "request_id": "r1", "choice": "once"}))));
        assert!(allowed(&input(json!({"kind": "clarify", "request_id": "r1", "answer": "yes"}))));
        assert!(!allowed(&input(json!({"kind": "send", "text": "hi", "images": ["/x.png"]}))));
        assert!(!allowed(&input(json!({"kind": "mode", "mode": "acceptEdits"}))));
        assert!(!allowed(&input(json!({"kind": "model", "model": "opus"}))));
        assert!(!allowed(&input(json!({"kind": "rewind"}))));
        assert!(!allowed(&input(json!({"kind": "steer", "id": "m1", "text": "x"}))));
    }
}
