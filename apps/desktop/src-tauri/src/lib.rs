mod accounts;
mod acp_agents;
mod api_link;
mod acp_chat;
mod acp_mcp;
mod agent_chat;
mod agent_config;
mod app_menu;
mod appimage;
mod ask_tool;
mod buddy_chat;
mod claude_usage;
mod credits;
mod computer;
mod custom_agents;
mod disk;
mod dsh_chat;
mod fg;
mod folder_open;
mod gh_me;
mod git_branch;
mod git_moved;
mod git_pull;
mod lane;
mod lane_clean;
mod lane_config;
mod lane_diff;
mod past_chats;
mod platform;
mod outpost;
mod power;
mod review;
mod preview;
mod providers;
#[cfg(all(test, unix))]
mod pty_bench;
mod running;
mod session_files;
mod sessions;
mod source_tools;
mod shop_cache;
mod shop_cache_key;
mod skill_links;
mod tasks;
mod term_history;
mod term_import;
mod term_link;
mod term_share;
mod this_host;
mod tray;
mod turn_files;
mod voice;
mod workflows;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use agent_chat::{ChatOut, ChatSessions};
use platform::Os;
use sessions::{AgentInfo, Output, Sessions};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use zeroize::Zeroizing;

/// What the commands share. Oh My Hermes also kept its Python bridge and its SSH links to other computers' bridges
/// here; Manut AI's runtime lives in the page behind `src/runtime`, so the shell owns only local processes.
struct Shell {
    logins: Arc<accounts::Logins>,
    sessions: Arc<Sessions>,
    chats: Arc<ChatSessions>,
    /// Buddy's chats through the person's own coding agent (buddy_chat.rs), kept apart from the coding sessions' so a
    /// coding session's reset never stops one and the page can send them only what a conversation needs.
    buddy: Arc<ChatSessions>,
    /// The lanes' previews (preview.rs): each a project's dev server, started by the page in a lane's own folder.
    previews: Arc<preview::Previews>,
}

/// Open a link the person clicked: a thread in its own app (Slack / Discord / Telegram), a plan node's GitHub
/// pull request, or a message's http(s) link (a link chip) in the default browser. The system opener (`open`
/// on macOS, the shell's URL handler on Windows, `xdg-open` on Linux) hands it to the person's own Slack /
/// Discord / browser. Nothing else: no file, `javascript:` or other scheme, no address with a user name or
/// password in it.
#[tauri::command]
async fn open_external(url: String) -> Result<(), String> {
    if !allowed_external(&url) {
        return Err("not a thread or web link".into());
    }
    // A Discord web link opens the Discord app when it is installed, the browser otherwise.
    if let Some(app_url) = discord_app_url(&url) {
        if discord_app_installed() && system_open_url(&app_url).is_ok() {
            return Ok(());
        }
    }
    system_open_url(&url)
}

/// The system opener for an address. On Linux it goes through `appimage::open`, which hands a link to
/// `xdg-open` without the AppImage's bundled-library environment (a plain install is unaffected).
fn system_open_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        appimage::open(url)
    }
    #[cfg(not(target_os = "linux"))]
    {
        tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
    }
}

/// `https://discord.com/channels/G/C` -> `discord://discord.com/channels/G/C` (the form the Discord app
/// routes to that exact channel or thread).
pub(crate) fn discord_app_url(url: &str) -> Option<String> {
    url.strip_prefix("https://discord.com/channels/")
        .map(|rest| format!("discord://discord.com/channels/{rest}"))
}

/// Whether the Discord desktop app is there to take `discord://`. macOS and Linux report a missing handler as
/// an open error (`xdg-open` exits non-zero, so the browser fallback runs); Windows would show an "find an app" dialog instead, so there
/// we look for the app first.
fn discord_app_installed() -> bool {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(|d| {
                let d = PathBuf::from(d);
                ["Discord", "DiscordPTB", "DiscordCanary"].iter().any(|n| d.join(n).join("Update.exe").is_file())
            })
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        true
    }
}

pub(crate) fn allowed_external(url: &str) -> bool {
    const PREFIXES: [&str; 5] = [
        "slack://channel?",
        "https://app.slack.com/",
        "https://discord.com/channels/",
        "discord://discord.com/channels/",
        "https://t.me/",
    ];
    !url.chars().any(|c| c.is_whitespace() || c.is_control())
        && (PREFIXES.iter().any(|p| url.starts_with(p)) || github_pr_url(url) || web_link(url))
}

/// `https://github.com/<owner>/<repo>/pull/<n>` and nothing after it: the pull request a plan node opened (the
/// Plans graph's `#2746`), shown in the browser when the person clicks it.
pub(crate) fn github_pr_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://github.com/") else { return false };
    let parts: Vec<&str> = rest.split('/').collect();
    let name = |s: &str, first: bool| {
        !s.is_empty()
            && s.len() <= 100
            && s != "."
            && s != ".."
            && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || (!first && (c == '_' || c == '.')))
    };
    parts.len() == 4
        && name(parts[0], true)
        && name(parts[1], false)
        && parts[2] == "pull"
        && !parts[3].is_empty()
        && parts[3].len() <= 7
        && parts[3].bytes().all(|b| b.is_ascii_digit())
}

/// An `http(s)://host/...` address with no user name or password before the host (`https://github.com@evil.io/`
/// reads as GitHub but goes to evil.io), as a link chip carries it.
pub(crate) fn web_link(url: &str) -> bool {
    let rest = match url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")) {
        Some(r) => r,
        None => return false,
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    !host.is_empty() && !host.contains('@') && !host.contains('\\')
}

fn user_home() -> Result<PathBuf, String> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "no home folder".to_string())
}

/// The env a new session of `cli` starts with to use manut account `id` (`default` = the CLI's own home).
/// SESSIONS calls this when it starts an agent with the account picked for new sessions.
#[tauri::command]
async fn account_env(cli: String, id: String) -> Result<Vec<(String, String)>, String> {
    accounts::account_env(&user_home()?, &cli, &id)
}

/// Which coding CLIs are on this computer (PATH and the install folders a Dock-started app does not see).
#[tauri::command]
async fn account_clis() -> Result<Vec<(&'static str, bool)>, String> {
    tauri::async_runtime::spawn_blocking(accounts::clis_on_this_computer).await.map_err(|e| e.to_string())
}

/// The CLI's own login status for account `id`, through its fixed status command (Claude Code, Codex). Only
/// signed in / email / plan / method come back; `null` for CLIs that have no status command.
#[tauri::command]
async fn account_status(cli: String, id: String) -> Result<Option<accounts::LoginStatus>, String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || accounts::status(&home, &cli, &id)).await.map_err(|e| e.to_string())?
}

/// The CLI's version through its fixed `--version` (Claude Code, Codex); only the version token comes back,
/// `null` for other CLIs or output with no version in it.
#[tauri::command]
async fn account_version(cli: String) -> Result<Option<String>, String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || accounts::version(&home, &cli)).await.map_err(|e| e.to_string())?
}

/// Start the CLI's own sign-in (`claude auth login`, `codex login`) with manut account `id` as its home. The
/// browser part happens in the CLI; its plain output lines and then its exit arrive on `on_event`.
#[tauri::command]
async fn account_login_start(
    shell: State<'_, Shell>,
    cli: String,
    id: String,
    on_event: tauri::ipc::Channel<accounts::LoginEvent>,
) -> Result<u32, String> {
    shell.logins.start(&user_home()?, &cli, &id, move |ev| {
        let _ = on_event.send(ev);
    })
}

/// Cancel a sign-in started above. Its exit still arrives on its channel.
#[tauri::command]
async fn account_login_cancel(shell: State<'_, Shell>, login: u32) -> Result<(), String> {
    shell.logins.cancel(login);
    Ok(())
}

/// Settings › Providers › Accounts: the accounts of Claude Code and Codex on this computer, read by the shell in every
/// mode (item 74: the Hermes bridge used to list them, so Practice and Connected had none). Never a token.
#[tauri::command]
async fn accounts_list() -> Result<Vec<accounts::Group>, String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || accounts::list_here(&home)).await.map_err(|e| e.to_string())
}

/// A new empty home folder for `cli` named from `label` (the page then runs the CLI's own sign-in with it).
#[tauri::command]
async fn accounts_add(cli: String, label: String) -> Result<serde_json::Value, String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || accounts::add(&home, &cli, &label).map(|(id, dir)| serde_json::json!({"id": id, "dir": dir})))
        .await
        .map_err(|e| e.to_string())?
}

/// The account new sessions of `cli` start with. Running sessions are untouched.
#[tauri::command]
async fn accounts_set_active(cli: String, account: String) -> Result<(), String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || accounts::set_active(&home, &cli, &account)).await.map_err(|e| e.to_string())?
}

/// The person's own name for a row ("" clears it).
#[tauri::command]
async fn accounts_label(cli: String, account: String, label: String) -> Result<(), String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || accounts::set_label(&home, &cli, &account, &label)).await.map_err(|e| e.to_string())?
}

/// Deletes `~/.manut/accounts/<cli>/<account>/` and nothing else.
#[tauri::command]
async fn accounts_remove(cli: String, account: String) -> Result<(), String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || accounts::remove(&home, &cli, &account)).await.map_err(|e| e.to_string())?
}

/// A cancelled sign-in's folder, removed; refused when the CLI did sign in there.
#[tauri::command]
async fn accounts_discard(cli: String, account: String) -> Result<(), String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || accounts::discard(&home, &cli, &account)).await.map_err(|e| e.to_string())?
}

/// Settings › Providers: every agent the app knows, with what the person set for it, as the shell read it now. Variables
/// come as names only: a value never leaves the shell once saved (`providers::View`).
#[tauri::command]
async fn providers_list() -> Result<Vec<providers::View>, String> {
    tauri::async_runtime::spawn_blocking(providers::list_here).await.map_err(|e| e.to_string())
}

/// One change to agent `id`'s settings, checked by the shell and saved in its own file; the answer is the agent's new view.
/// A refusal is `why:<code>` or `why:<code>:<option or variable name>`, never a value.
#[tauri::command]
async fn provider_save(id: String, patch: providers::Patch) -> Result<providers::View, String> {
    tauri::async_runtime::spawn_blocking(move || providers::save_here(&id, patch)).await.map_err(|e| e.to_string())?
}

/// The version agent `id`'s program prints with `--version` (the token only), for the agents whose flag was read here.
#[tauri::command]
async fn provider_version(id: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || providers::version_here(&id)).await.map_err(|e| e.to_string())?
}

/// The allow-listed agent programs (claude, codex, omo, dsh, omh, pi, omp, grok), how each opens and where each
/// was found, if anywhere.
/// One row of the agent look-up: an allow-listed agent, or one the person added on Settings › Agents.
#[derive(serde::Serialize)]
#[serde(untagged)]
enum AnyAgent {
    Listed(AgentInfo),
    Custom(custom_agents::CustomInfo),
}

#[tauri::command]
async fn sessions_agents() -> Result<Vec<AnyAgent>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        // what Settings › Providers says of each (turned off, a display name, a program path), read once for the list
        let cfg = providers::load_here();
        let mut all: Vec<AnyAgent> = sessions::agents_on_this_machine_with(&cfg).into_iter().map(AnyAgent::Listed).collect();
        // then the person's own agents, each checked as the file is read now (a broken entry is not listed here)
        all.extend(custom_agents::list_here().agents.into_iter().map(|mut c| {
            c.off = cfg.get(&c.id).off;
            AnyAgent::Custom(c)
        }));
        all
    })
    .await
    .map_err(|e| e.to_string())
}

/// Settings › Agents: the person's own agents (where each program is now) and the entries of the file that are
/// broken (skipped, never run). Reads manut's own file only.
#[tauri::command]
async fn custom_agents_list() -> Result<custom_agents::CustomList, String> {
    tauri::async_runtime::spawn_blocking(custom_agents::list_here).await.map_err(|e| e.to_string())
}

/// The confirm card for the Add agent form: the entry the four fields make, checked, and the exact command manut
/// would run (the program as found now, then the arguments; none when it is not found). Writes nothing. A refusal is
/// `why:<code>`.
#[tauri::command]
async fn custom_agent_preview(label: String, program: String, args: String, install: String) -> Result<custom_agents::Preview, String> {
    tauri::async_runtime::spawn_blocking(move || custom_agents::preview_here(&label, &program, &args, &install).map_err(|w| format!("why:{}", w.code())))
        .await
        .map_err(|e| e.to_string())?
}

/// The card's Add, the only way an entry is written: `entry` is checked again and added to manut's own file.
#[tauri::command]
async fn custom_agent_confirm(entry: custom_agents::CustomAgent) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = custom_agents::home().ok_or("no home folder")?;
        custom_agents::confirm_add(&home, &entry, Os::current(), sessions::is_program_file).map_err(|w| format!("why:{}", w.code()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The confirm card for a bot's draft (an `manut-agent` block in its reply, read by the UI): the same check as the
/// form's preview and stricter (no shell, interpreter or built-in program), the arguments as the draft's own list.
/// Writes nothing; only the card's Add (`custom_agent_confirm`) does. A refusal is `why:<code>`.
#[tauri::command]
async fn custom_agent_bot_preview(label: String, program: String, args: Vec<String>, install: String) -> Result<custom_agents::Preview, String> {
    tauri::async_runtime::spawn_blocking(move || custom_agents::bot_preview_here(&label, &program, &args, &install).map_err(|w| format!("why:{}", w.code())))
        .await
        .map_err(|e| e.to_string())?
}

/// The remove confirm: agent `id` leaves manut's own file (a broken entry too).
#[tauri::command]
async fn custom_agent_remove(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = custom_agents::home().ok_or("no home folder")?;
        custom_agents::confirm_remove(&home, &id).map_err(|w| format!("why:{}", w.code()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Start allow-listed agent `agent` in folder `cwd` in a new pseudo-terminal (its own terminal UI). Only an
/// agent id crosses from the UI: no program path, command line or argument; `session_id` is a new Claude Code
/// conversation id the page made, `resume` a Claude Code or Codex conversation id to continue, each checked to be a
/// UUID (`sessions::terminal_args`); `link` is an oh-my-hermes row's link id, which that terminal gets as
/// `MANUT_TERMINAL_LINK` (`sessions::terminal_env`: `omh` only, 10 lowercase base32 characters); `account` is the
/// account a session restarted after an app restart ran with (checked by `accounts::session_env_for`). Terminal output
/// goes to `on_data` as raw bytes, the exit code (null after a signal) once to `on_exit`.
#[tauri::command]
async fn session_start(
    app: AppHandle,
    shell: State<'_, Shell>,
    agent: String,
    cwd: String,
    session_id: Option<String>,
    resume: Option<String>,
    link: Option<String>,
    account: Option<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<Option<u32>>,
) -> Result<u32, String> {
    let sessions = shell.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // The account Settings › Accounts picked for new sessions of this agent's CLI (or, for a session started
        // again after a restart, the one it ran with): its home variable, or nothing ("This computer").
        // chat_start passes the same. An added account gets the person's MCP servers, skills and settings first, never
        // their sign-in (`accounts::share`).
        let account_env = user_home().map(|h| accounts::session_env_for(&h, &agent, account.as_deref())).unwrap_or_default();
        if let Ok(h) = user_home() {
            accounts::prepare(&h, &agent, &account_env);
        }
        sessions.start_agent(&agent, std::path::Path::new(&cwd), session_id.as_deref(), resume.as_deref(), link.as_deref(), &account_env, cols, rows, move |ev| match ev {
            Output::Data(b) => {
                let _ = on_data.send(InvokeResponseBody::Raw(b));
            }
            Output::Exit(code) => {
                let _ = on_exit.send(code);
            }
        })
        .inspect(|id| watch_foreground(&sessions, &app, *id))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The bottom terminal panel's shell: the person's own login shell (`sessions::shell_argv`, decided by the shell,
/// never by the page) in `cwd` when that is an existing folder, else home. The page sends a folder and a size only;
/// the session is then written, acknowledged, resized and closed with the `session_*` commands like any other.
#[tauri::command]
async fn shell_start(
    app: AppHandle,
    shell: State<'_, Shell>,
    cwd: Option<String>,
    shell_id: Option<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<Option<u32>>,
) -> Result<ShellStarted, String> {
    let sessions = shell.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let home = user_home()?;
        let (id, at, missing) = sessions.start_shell(cwd.as_deref(), shell_id.as_deref(), &home, cols, rows, move |ev| match ev {
            Output::Data(b) => {
                let _ = on_data.send(InvokeResponseBody::Raw(b));
            }
            Output::Exit(code) => {
                let _ = on_exit.send(code);
            }
        })?;
        watch_foreground(&sessions, &app, id);
        Ok(ShellStarted { id, cwd: at.to_string_lossy().into_owned(), missing })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The shells a TERMINALS Shell row may run (`sessions::shells_available`: fixed candidates whose files exist, the
/// default first). The page shows them and sends back an id only (`shell_start`'s `shell_id`).
#[tauri::command]
async fn shells_available(shell: State<'_, Shell>) -> Result<Vec<sessions::ShellEntry>, String> {
    let sessions = shell.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || sessions.shells()).await.map_err(|e| e.to_string())
}

/// How often the foreground watcher wakes: a terminal session that had output or input since its foreground program
/// was last looked at is looked at on the next wake, an idle one every `sessions::FG_IDLE_TICKS` wakes (5 s).
const FOREGROUND_EVERY: Duration = Duration::from_secs(1);

/// The page hears `session-fg` `{id, agent}` when the agent CLI in the foreground of terminal session `id` changes:
/// its id (`claude`, `codex`, … the ids of src/ui/AgentIcon.tsx) or null (a shell or any other program). Nothing is
/// sent while it stays the same; a session starts at null, and one that ends goes back to null (`fg.rs`).
fn watch_foreground(sessions: &Arc<Sessions>, app: &AppHandle, id: u32) {
    let app = app.clone();
    sessions.watch_foreground(id, FOREGROUND_EVERY, move |agent| {
        let _ = app.emit("session-fg", SessionFg { id, agent });
    });
}

/// The `session-fg` event's payload.
#[derive(Clone, serde::Serialize)]
struct SessionFg {
    id: u32,
    agent: Option<&'static str>,
}

/// A started terminal-panel shell: its session id and the folder it started in.
#[derive(serde::Serialize)]
struct ShellStarted {
    id: u32,
    cwd: String,
    /// the shell asked for was not on this machine's list: its name (the default shell started instead)
    #[serde(skip_serializing_if = "Option::is_none")]
    missing: Option<String>,
}

/// What keeps running (running.rs, the page's src/running/): every command that this app's terminals and chats started
/// and that still runs, and every lane's preview, with its arguments, when it started and the ports it listens on. Only
/// processes under a session or a preview this app started are looked at, and the page sends nothing. `unsupported` where
/// the shell has no reader (Windows).
#[tauri::command]
async fn running_list(shell: State<'_, Shell>) -> Result<Vec<running::Row>, String> {
    let roots = running::roots_of(&shell.sessions, &shell.chats, &shell.previews);
    tauri::async_runtime::spawn_blocking(move || running::list(&roots)).await.map_err(|e| e.to_string())?
}

/// Stop one command of those and everything it started: `stopping` once each is told to end (what still runs a few
/// seconds later is killed), `gone` when it is not there to stop. The page names the command by its session, its process
/// id and when it started, never by words; the shell finds it under that session again, so nothing else can be reached.
/// A preview is stopped as its own Stop stops it (its process group), so its pane says that it was stopped.
#[tauri::command]
async fn running_stop(shell: State<'_, Shell>, kind: String, session: u32, pid: u32, started: Option<u64>) -> Result<&'static str, String> {
    let kind = running::Kind::parse(&kind).ok_or("not a kind of session")?;
    if kind == running::Kind::Preview {
        return Ok(if shell.previews.is(session, pid) { shell.previews.stop(session) } else { "gone" });
    }
    let roots = running::roots_of(&shell.sessions, &shell.chats, &shell.previews);
    tauri::async_runtime::spawn_blocking(move || running::stop(&roots, &running::Target { kind, session, pid, started })).await.map_err(|e| e.to_string())?
}

/// This computer's name (empty when the system gives none), asked once when the page starts: the page uses it only to
/// accept a terminal's OSC 7 folder from this computer.
#[tauri::command]
fn host_name() -> String {
    this_host::name()
}

/// The connected runtime's one way to reach apps/api (api_link.rs): the page names the address, the method, the
/// session token and the body, and gets back the status and the body, or `offline` / `failed`. The shell checks the
/// address itself (https, or plain http on this computer; `/v1/` paths only), whatever the page sends.
#[tauri::command]
async fn api_request(url: String, method: String, bearer: Option<String>, body: Option<String>) -> Result<api_link::ApiAnswer, String> {
    let bearer = bearer.map(Zeroizing::new);
    tauri::async_runtime::spawn_blocking(move || api_link::request(&url, &method, bearer.as_ref().map(|b| b.as_str()), body.as_deref()))
        .await
        .map_err(|_| "failed".to_string())?
        .map_err(api_link::LinkError::wire)
}

/// The API session the keychain holds for the connected runtime, or none (api_link.rs). Off the main thread: a locked
/// keychain asks the person first.
#[tauri::command]
async fn api_session_read() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(api_link::session_read).await.map_err(|_| "keychain".to_string())?
}

/// Replaces the API session the keychain holds.
#[tauri::command]
async fn api_session_write(value: String) -> Result<(), String> {
    let value = Zeroizing::new(value);
    tauri::async_runtime::spawn_blocking(move || api_link::session_write(&value)).await.map_err(|_| "keychain".to_string())?
}

/// Removes the API session from the keychain (signing out, or a session the API ended).
#[tauri::command]
async fn api_session_clear() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(api_link::session_clear).await.map_err(|_| "keychain".to_string())?
}

/// The connected runtime's last good read of the shop, kept for when the API cannot be reached (shop_cache.rs,
/// src/runtime/http/cache.ts): `~/.manut/shop-cache/<key>.json`, owner-only, written through a temporary file and renamed,
/// and only ever one shop's. `key` is the 64 hex digits the page makes of the shop; the shell takes no path. `text` comes
/// sealed (src/runtime/http/seal.ts), with the key `shop_cache_seal_key` gives.
#[tauri::command]
async fn shop_cache_write(key: String, text: String) -> Result<(), String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || shop_cache::write(&home, &key, &text)).await.map_err(|e| e.to_string())?
}

/// What the saved read of shop `key` holds, or null when none is kept.
#[tauri::command]
async fn shop_cache_read(key: String) -> Result<Option<String>, String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || shop_cache::read(&home, &key)).await.map_err(|e| e.to_string())?
}

/// Removes the saved read of the shop (signing out, a session the API ended, switching to Practice or to another origin).
#[tauri::command]
async fn shop_cache_clear() -> Result<(), String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || shop_cache::clear(&home)).await.map_err(|e| e.to_string())?
}

/// The key the saved read is sealed with, as 64 hex digits, from the keychain (shop_cache_key.rs): made and kept first when
/// `make` is set and none is held, else null when none is held. `unavailable` on a computer with no keychain support, where
/// the page keeps no copy. Off the main thread: a locked keychain asks the person first.
#[tauri::command]
async fn shop_cache_seal_key(make: bool) -> Result<Option<String>, String> {
    let key = tauri::async_runtime::spawn_blocking(move || shop_cache_key::get(make)).await.map_err(|_| "keychain".to_string())??;
    Ok(key.map(|k| k.as_str().to_owned()))
}

/// Deletes the key the saved read is sealed with, as the page forgets the read, so a copy of the file that outlived the
/// forgetting can never be opened.
#[tauri::command]
async fn shop_cache_seal_key_clear() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(shop_cache_key::clear).await.map_err(|_| "keychain".to_string())?
}

/// Keystrokes (and pastes) from the terminal view into session `id`.
#[tauri::command]
async fn session_write(shell: State<'_, Shell>, id: u32, data: String) -> Result<(), String> {
    shell.sessions.write(id, data.as_bytes())
}

/// The terminal view has drawn `bytes` more of session `id`'s output. The session's reader stops reading its
/// program while the page is behind and reads again as this credit comes back (`FLOW_HIGH` / `FLOW_LOW` in
/// sessions.rs). Two numbers only; nothing is read or written.
#[tauri::command]
async fn session_ack(shell: State<'_, Shell>, id: u32, bytes: u64) -> Result<(), String> {
    shell.sessions.ack(id, bytes);
    Ok(())
}

#[tauri::command]
async fn session_resize(shell: State<'_, Shell>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    shell.sessions.resize(id, cols, rows)
}

/// Stop the session's program and forget the session.
#[tauri::command]
async fn session_close(shell: State<'_, Shell>, id: u32) -> Result<(), String> {
    shell.sessions.close(id);
    Ok(())
}

/// Stop every session. `main.tsx` calls this once per page load, before any UI renders, so a reloaded
/// window leaves nothing running unseen.
#[tauri::command]
async fn session_close_all(shell: State<'_, Shell>) -> Result<(), String> {
    let sessions = shell.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || sessions.close_all()).await.map_err(|e| e.to_string())
}

/// Start allow-listed agent `agent` in folder `cwd` as a chat: its structured mode (the fixed arguments in
/// the allow-list), with events for the chat view on `on_event` and, once, `{event:"exit", code, error}`.
/// Only an agent id, a folder, optionally a Claude Code session id or Codex thread id, optionally the account a
/// restarted session ran with, and the SESSIONS id (`s<digits>`, whose attachment folder a Claude Code chat may
/// read) cross from the UI.
#[tauri::command]
async fn chat_start(shell: State<'_, Shell>, agent: String, cwd: String, resume: Option<String>, account: Option<String>, session: Option<String>, suggest: Option<bool>, on_event: Channel<serde_json::Value>) -> Result<u32, String> {
    let chats = shell.chats.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // The same account as a terminal session of this agent: its home variable, or nothing ("This computer"), with the
        // person's configuration shared into an added account's home first.
        let account_env = user_home().map(|h| accounts::session_env_for(&h, &agent, account.as_deref())).unwrap_or_default();
        if let Ok(h) = user_home() {
            accounts::prepare(&h, &agent, &account_env);
        }
        // Claude Code: the session's attachment folder (`s<digits>` under ~/.manut/session-files), made now so its
        // copies are readable without a card; no folder (a bad id, a link) only means a card per read
        let files = match (agent.as_str(), session.as_deref()) {
            ("claude", Some(s)) => user_home().and_then(|h| session_files::session_dir(&h, s)).ok(),
            _ => None,
        };
        chats.start_agent_with(&agent, std::path::Path::new(&cwd), resume.as_deref(), &account_env, files.as_deref(), suggest.unwrap_or(false), move |out| {
            let _ = on_event.send(match out {
                ChatOut::Event(e) => e,
                ChatOut::Exit(code, error) => serde_json::json!({"event": "exit", "code": code, "error": error}),
            });
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What the person did in chat `id`: `{kind:"send", text, images, id}`, `{kind:"interrupt"}`,
/// `{kind:"approve", request_id, choice}`, `{kind:"clarify", request_id, answer}`, `{kind:"model", model}`,
/// `{kind:"mode", mode}` (one of `agent_chat::modes_for`), `{kind:"effort", effort}`.
#[tauri::command]
async fn chat_input(shell: State<'_, Shell>, id: u32, input: agent_chat::Input) -> Result<(), String> {
    let chats = shell.chats.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut input = input;
        // attached pictures: only files manut saved under its own session folder are read
        input.resolve(&user_home()?)?;
        chats.input(id, input)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Save one file the person attached in SESSIONS chat (or dropped on its terminal) `x-session` as
/// `~/.manut/session-files/<session>/<n>-<name>` and return that path. The body is the file's bytes; the name
/// comes percent-encoded in `x-name`. Nothing else is written.
#[tauri::command]
async fn session_file_save(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_string).unwrap_or_default();
    let (session, name) = (header("x-session"), session_files::percent_decode(&header("x-name")));
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else { return Err("expected the file's bytes".into()) };
    let data = data.clone();
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || session_files::save(&home, &session, &name, &data).map(|p| p.to_string_lossy().into_owned()))
        .await
        .map_err(|e| e.to_string())?
}

/// The bytes of a file saved by `session_file_save` (a sent bubble's picture after manut restarted). Any other
/// path is refused.
#[tauri::command]
async fn session_file_read(path: String) -> Result<tauri::ipc::Response, String> {
    let home = user_home()?;
    let real = session_files::check(&home, &path)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(real)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Tasks: whether `source`'s CLI (`gh` / `glab`) is on this computer and signed in, by `auth status`'s exit code
/// only (rule 33). `fresh` asks again instead of the last minute's answer.
#[tauri::command]
async fn tasks_status(tasks: State<'_, Arc<tasks::Tasks>>, source: String, fresh: Option<bool>) -> Result<tasks::Status, String> {
    let src = tasks::Source::parse(&source)?;
    let t = Arc::clone(&tasks);
    tauri::async_runtime::spawn_blocking(move || t.status(src, fresh.unwrap_or(false))).await.map_err(|e| e.to_string())
}

/// Tasks: one page of open issues or pull / merge requests of `repo`, through the person's own CLI with a fixed,
/// read-only argv (rule 33). The page sends only these words and numbers.
/// `account` (GitHub only): a GitHub account chosen in manut (`<login>@<host>`, a github.com one: `Me::repo_list`),
/// read as through gh_me.rs; none: gh's own active account.
#[tauri::command]
async fn tasks_list(
    tasks: State<'_, Arc<tasks::Tasks>>,
    me: State<'_, Arc<gh_me::Me>>,
    source: String,
    repo: String,
    kind: String,
    filter: String,
    page: u32,
    account: Option<String>,
) -> Result<tasks::Page, String> {
    let (src, kind, filter) = (tasks::Source::parse(&source)?, tasks::Kind::parse(&kind)?, tasks::Filter::parse(&filter)?);
    let (t, m) = (Arc::clone(&tasks), Arc::clone(&me));
    tauri::async_runtime::spawn_blocking(move || match account.filter(|_| src == tasks::Source::Github) {
        Some(acc) => m.repo_list(&t, kind, &repo, filter, page, &acc),
        None => t.list(src, kind, &repo, filter, page),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Tasks: one item's description, comments and checks, read-only (rule 33). `account`: a chosen account, on any
/// host it is on (a "나" row read as a GitHub Enterprise account is read there: `Me::view`).
#[tauri::command]
async fn tasks_view(
    tasks: State<'_, Arc<tasks::Tasks>>,
    me: State<'_, Arc<gh_me::Me>>,
    source: String,
    repo: String,
    kind: String,
    number: u64,
    account: Option<String>,
) -> Result<tasks::Detail, String> {
    let (src, kind) = (tasks::Source::parse(&source)?, tasks::Kind::parse(&kind)?);
    let (t, m) = (Arc::clone(&tasks), Arc::clone(&me));
    tauri::async_runtime::spawn_blocking(move || match account.filter(|_| src == tasks::Source::Github) {
        Some(acc) => m.view(&t, kind, &repo, number, &acc),
        None => t.view(src, kind, &repo, number),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Settings › Accounts › GitHub and Tasks › 나: the GitHub accounts gh is signed in to, from `gh auth status --json
/// hosts` (host, login, active, state and scopes only; rules 18 and 33). `fresh` asks again.
#[tauri::command]
async fn gh_accounts(me: State<'_, Arc<gh_me::Me>>, fresh: Option<bool>) -> Result<gh_me::GhAccounts, String> {
    let m = Arc::clone(&me);
    tauri::async_runtime::spawn_blocking(move || m.accounts(fresh.unwrap_or(false))).await.map_err(|e| e.to_string())
}

/// Tasks › 나: one page of `section` (`review`, `authored`, `assigned`, `mentions`) across every repository, as GitHub
/// account `account` (rule 33). The page sends only these words and the page number; the argv is gh_me.rs's own.
#[tauri::command]
async fn tasks_me(me: State<'_, Arc<gh_me::Me>>, account: String, section: String, page: u32, fresh: Option<bool>) -> Result<gh_me::MePage, gh_me::MeError> {
    let sec = gh_me::Section::parse(&section).map_err(|e| gh_me::MeError::new("other", e))?;
    let m = Arc::clone(&me);
    tauri::async_runtime::spawn_blocking(move || m.list(&account, sec, page, fresh.unwrap_or(false))).await.map_err(|e| gh_me::MeError::new("other", e.to_string()))?
}

/// Settings › Source control (item 75): git, gh and glab, each on this computer or not, its version, and for the two CLIs
/// whether it is signed in and as whom (names only), read through the runners Tasks already uses (source_tools.rs). `fresh`
/// asks the CLIs again. Only reads.
#[tauri::command]
async fn source_tools(tasks: State<'_, Arc<tasks::Tasks>>, me: State<'_, Arc<gh_me::Me>>, fresh: Option<bool>) -> Result<source_tools::Tools, String> {
    let (t, m) = (Arc::clone(&tasks), Arc::clone(&me));
    tauri::async_runtime::spawn_blocking(move || source_tools::read(&t, &m, fresh.unwrap_or(false))).await.map_err(|e| e.to_string())
}

/// Settings › Accounts › GitHub: gh's own sign-in for one more account in a terminal-panel tab (`gh auth login`, or
/// `--hostname <host>` for GitHub Enterprise; rule 18). The page sends only the host (checked) and a size.
#[tauri::command]
async fn gh_login_start(
    shell: State<'_, Shell>,
    host: Option<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<Option<u32>>,
) -> Result<ShellStarted, String> {
    let sessions = shell.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let home = user_home()?;
        let args = gh_me::login_argv(host.as_deref())?;
        let gh = tasks::find("gh").ok_or("gh is not installed")?;
        let id = sessions.start_gh_login(&gh, args, &home, cols, rows, move |ev| match ev {
            Output::Data(b) => {
                let _ = on_data.send(InvokeResponseBody::Raw(b));
            }
            Output::Exit(code) => {
                let _ = on_exit.send(code);
            }
        })?;
        Ok(ShellStarted { id, cwd: home.to_string_lossy().into_owned(), missing: None })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Tasks: the GitHub / GitLab repository folder `cwd` is in, from its `.git/config` (no program runs); null when none.
#[tauri::command]
async fn tasks_remote(cwd: String) -> Result<Option<tasks::Remote>, String> {
    Ok(tasks::folder_remote(std::path::Path::new(&cwd)))
}

/// The git branch of a session's folder, from its `.git/HEAD` only (no program runs); "" outside a repository.
#[tauri::command]
async fn session_branch(cwd: String) -> Result<String, String> {
    Ok(git_branch::branch(std::path::Path::new(&cwd)))
}

/// A lane's own working folder (src/code/laneBranch.ts): a git worktree under `~/.manut/lanes`, on the first of `names` that no
/// branch has, made from the commit the folder `cwd` is on. The developer's folder is not touched (its branch, index, stash
/// and HEAD stay as they are), and nothing is pushed or merged. The page sends only names of the form `kit/<words>`; a
/// refusal is a short code (`not_a_repository`, `no_commit`, `not_committed`, `busy`, `taken`, `bad_name`, `git_missing`,
/// `no_folder`) or git's own last line.
#[tauri::command]
async fn lane_worktree(cwd: String, names: Vec<String>, start: Option<lane::Start>) -> Result<lane::Made, String> {
    let home = user_home()?;
    let start = start.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || lane::make_with(&home, std::path::Path::new(&cwd), &names, &start)).await.map_err(|e| e.to_string())?
}

/// Settings › MCP and Skills: the MCP servers and skills Claude Code and Codex have, by name and where each comes from, read
/// from their own files for the person's own home and, when given, the project folder `cwd` (agent_config.rs). Only reads,
/// and names only: never a command, an argument, an environment value, a header or an address.
#[tauri::command]
async fn agent_config_list(cwd: Option<String>) -> Result<Vec<agent_config::AgentConfig>, String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || {
        let project = cwd.map(PathBuf::from).filter(|p| p.is_absolute());
        agent_config::read(&home, project.as_deref(), &|k| std::env::var(k).ok())
    })
    .await
    .map_err(|e| e.to_string())
}

/// Sharing skills by a link (item 84, skill_links.rs): the person's own skill folders `folders` of `agent` (`claude` or `codex`,
/// by folder name as Settings › MCP and Skills lists them), read so the page can show every file before anything is asked. Only
/// reads, and nothing is followed through a link. Rejects `bad_agent`, `no_skills`, or `<why>:<folder>`.
#[tauri::command]
async fn skill_bundle_read(agent: String, folders: Vec<String>) -> Result<Vec<skill_links::ReadSkill>, String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || {
        let roots = agent_config::home_skill_roots(&home, &agent, &|k| std::env::var(k).ok());
        if roots.is_empty() {
            return Err("bad_agent".to_string());
        }
        if folders.is_empty() || folders.len() > skill_links::MAX_SKILLS {
            return Err("no_skills".to_string());
        }
        folders.iter().map(|f| skill_links::read_skill(&roots, f).map_err(|e| format!("{e}:{f}"))).collect()
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Installing skills from a link (skill_links.rs): the bundle at `link`, fetched only when it is on `origin`, the artifact origin
/// the API named (`other_host` before anything is fetched otherwise), held to the bundle rules again and kept here by id.
#[tauri::command]
async fn skill_link_read(installs: State<'_, Arc<skill_links::Installs>>, link: String, origin: String) -> Result<skill_links::LinkRead, String> {
    let l = Arc::clone(&installs);
    tauri::async_runtime::spawn_blocking(move || {
        let bundle = skill_links::read_link(&link, &origin, &api_link::fetch_link)?;
        let read = l.keep_read(bundle.clone());
        Ok(skill_links::LinkRead { read, title: bundle.title, skills: bundle.skills })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The ask to install skills `names` of kept bundle `read` for `agent`, into that agent's own skills folder. Writes nothing;
/// rejects `exists:<name>` for a skill it has, `link_root`, `bad_bundle:<why>`, `not_found` or `expired`.
#[tauri::command]
async fn skill_install_ask(installs: State<'_, Arc<skill_links::Installs>>, read: String, names: Vec<String>, agent: String) -> Result<skill_links::InstallAsk, String> {
    let home = user_home()?;
    let l = Arc::clone(&installs);
    tauri::async_runtime::spawn_blocking(move || {
        let root = agent_config::install_root(&home, &agent, &|k| std::env::var(k).ok()).ok_or("bad_agent")?;
        l.ask(&home, &agent, &root, &read, &names)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The person's answer to install ask `id`, once approval-core settled it on the page: a No writes nothing, a Yes writes what the
/// ask named, once, with no executable bit, running nothing. Only the id and the answer cross.
#[tauri::command]
async fn skill_install_settle(installs: State<'_, Arc<skill_links::Installs>>, id: String, yes: bool) -> Result<skill_links::InstallDone, String> {
    let l = Arc::clone(&installs);
    tauri::async_runtime::spawn_blocking(move || l.settle(&id, yes)).await.map_err(|e| e.to_string())?
}

/// Takes a waiting install ask back, so a later answer to it writes nothing.
#[tauri::command]
async fn skill_install_withdraw(installs: State<'_, Arc<skill_links::Installs>>, id: String) -> Result<(), String> {
    installs.withdraw(&id);
    Ok(())
}

/// Settings › Workflows (item 77b): the workflow files in `~/.manut/workflows/`, read now (workflows.rs). Only reads: a file
/// the shell cannot read is listed with why, never changed.
#[tauri::command]
async fn workflows_read() -> Result<workflows::Folder, String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || workflows::read(&home)).await.map_err(|e| e.to_string())
}

/// Settings › Workflows' Show folder: the folder made when it is not there yet (never through a link), and its path.
#[tauri::command]
async fn workflows_folder() -> Result<String, String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || workflows::make(&home).map(|p| p.to_string_lossy().into_owned())).await.map_err(|e| e.to_string())?
}

/// Settings › Worktrees: the folder the person chose for lanes' folders, checked and made (lane.rs `check_lanes_root`): its real
/// path, or a short code (`bad_root`, `root_too_broad`, `root_in_checkout`, `root_unwritable`).
#[tauri::command]
async fn lane_root_check(root: String) -> Result<String, String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || lane::check_lanes_root(&home, &root).map(|p| p.to_string_lossy().into_owned())).await.map_err(|e| e.to_string())?
}

/// A clean-up removes a lane's folder (a deleted chat's) only when nothing in it is changed or new, git is not partway through
/// something there and every commit on its branch is on a remote (lane.rs `release`); the branch stays.
#[tauri::command]
async fn lane_release(worktree: String) -> Result<lane::Released, String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || lane::release(&home, &worktree, true)).await.map_err(|e| e.to_string())?
}

/// A clean-up of the lanes whose pull request merged, for the repository `cwd` is in (lane_clean.rs): reads pull requests
/// through the person's own `gh` or `glab`, and removes only folders with nothing of their own in them. `held`: the folders a
/// session still works in, which are left alone.
#[tauri::command]
async fn lane_clean_merged(tasks: State<'_, Arc<tasks::Tasks>>, cwd: String, held: Vec<String>) -> Result<lane_clean::Cleaned, String> {
    let home = user_home()?;
    let tasks = tasks.inner().clone();
    tauri::async_runtime::spawn_blocking(move || lane_clean::merged(&home, std::path::Path::new(&cwd), &held, &tasks)).await.map_err(|e| e.to_string())?
}

/// Settings › Source control › Automatically pull (item 75): bring the default branch checked out in the project folder `cwd`
/// up to date with its remote, only when nothing in it is changed, new, unpushed or in progress and only by a fast-forward
/// (git_pull.rs). Never a lane's folder. The answer says what happened or why nothing was done.
#[tauri::command]
async fn source_pull(cwd: String) -> Result<git_pull::Pulled, String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || git_pull::pull(&home, std::path::Path::new(&cwd))).await.map_err(|e| e.to_string())
}

/// A lane put up for review (item 75): what it would go up with, its branch, base and commits' subjects (review.rs `draft`).
/// Only reads.
#[tauri::command]
async fn review_draft(asks: State<'_, Arc<review::Ledger>>, worktree: String) -> Result<review::Draft, String> {
    let home = user_home()?;
    let l = Arc::clone(&asks);
    tauri::async_runtime::spawn_blocking(move || l.draft(&home, &worktree)).await.map_err(|e| e.to_string())?
}

/// The ask to push the lane at `worktree` and open its pull request with `title` and `body` (review.rs `ask_open`): the exact
/// repository, branch, base, title and body, or why it cannot go up. Writes nothing.
#[tauri::command]
async fn review_ask_open(asks: State<'_, Arc<review::Ledger>>, worktree: String, title: String, body: String) -> Result<review::Ask, String> {
    let home = user_home()?;
    let l = Arc::clone(&asks);
    tauri::async_runtime::spawn_blocking(move || l.ask_open(&home, &worktree, &title, &body)).await.map_err(|e| e.to_string())?
}

/// The ask to merge pull request `number`, made from the lane at `worktree`, with `method` (`merge`, `squash` or `rebase`;
/// review.rs `ask_merge`): asked only when it can merge now, naming the method and exactly the message that will be sent, with
/// the recognised agent credit lines taken out when `credits` (Settings › Source control). Writes nothing.
#[tauri::command]
async fn review_ask_merge(asks: State<'_, Arc<review::Ledger>>, worktree: String, number: u64, method: String, credits: Option<bool>) -> Result<review::Ask, String> {
    let home = user_home()?;
    let l = Arc::clone(&asks);
    tauri::async_runtime::spawn_blocking(move || l.ask_merge(&home, &worktree, number, &method, credits.unwrap_or(false))).await.map_err(|e| e.to_string())?
}

/// The person's answer to ask `id`, once approval-core settled it on the page (review.rs `settle`): a No runs nothing, a Yes runs
/// what the ask named, once. Only the id and the answer cross; never an argv, a branch or a text.
#[tauri::command]
async fn review_settle(asks: State<'_, Arc<review::Ledger>>, id: String, yes: bool) -> Result<review::Done, String> {
    let l = Arc::clone(&asks);
    tauri::async_runtime::spawn_blocking(move || l.settle(&id, yes)).await.map_err(|e| e.to_string())?
}

/// Takes a waiting ask back, so a later answer to it runs nothing (review.rs `withdraw`).
#[tauri::command]
async fn review_withdraw(asks: State<'_, Arc<review::Ledger>>, id: String) -> Result<(), String> {
    asks.withdraw(&id);
    Ok(())
}

/// The lanes' working folders the app made for the repository `cwd` is in, with what is in each (lane.rs). Only reads.
#[tauri::command]
async fn lane_list(cwd: String) -> Result<Vec<lane::Kept>, String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || lane::list(&home, std::path::Path::new(&cwd))).await.map_err(|e| e.to_string())?
}

/// The developer's folders the app's lanes were made from (lane.rs), so the Code page lists a project whose last session closed
/// while its lane's folder was kept. Only reads.
#[tauri::command]
async fn lane_projects() -> Result<Vec<String>, String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || lane::projects(&home)).await.map_err(|e| e.to_string())
}

/// Removes a lane's working folder the app made, and its branch when asked, once what is there is what the person saw
/// (`ask`: the changed files and the commits they said may go; lane.rs). Refuses anything the app did not make.
#[tauri::command]
async fn lane_remove(worktree: String, ask: lane::RemoveAsk) -> Result<lane::Removed, String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || lane::remove(&home, &worktree, &ask)).await.map_err(|e| e.to_string())?
}

/// The main branch moving while Kit worked, for the Code page's lane (src/code/moved.ts): the folder's branch, the branch it
/// started from, and the files each side changed since. Runs the person's own `git`, read-only (git_moved.rs); null when
/// there is nothing to say. `show` are the paths whose two diffs are wanted.
#[tauri::command]
async fn session_main_moved(cwd: String, base: Option<String>, show: Option<Vec<String>>) -> Result<Option<git_moved::MainMoved>, String> {
    tauri::async_runtime::spawn_blocking(move || git_moved::main_moved(std::path::Path::new(&cwd), base.as_deref(), &show.unwrap_or_default()))
        .await
        .map_err(|e| e.to_string())?
}

/// What really changed in the lane's own folder since it started, from git, for the Diff beside the lane (lane_diff.rs). Only a
/// folder the app made is read; the answer is a short code otherwise.
#[tauri::command]
async fn lane_diff(worktree: String) -> Result<lane_diff::LaneDiff, String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || lane_diff::read(&home, &worktree)).await.map_err(|e| e.to_string())?
}

/// Remove session `session`'s saved files (it was closed).
#[tauri::command]
async fn session_files_remove(session: String) -> Result<(), String> {
    session_files::remove(&user_home()?, &session)
}

/// Remove the saved files of every session not in `keep` (manut started; the others are gone).
#[tauri::command]
async fn session_files_prune(keep: Vec<String>) -> Result<(), String> {
    session_files::prune(&user_home()?, &keep)
}

/// Keep what terminal `key` (a SESSIONS id or `panel-<n>`) shows, for after a restart:
/// `~/.manut/term-history/<key>.txt`, owner-only, its newest 2000 lines / 1 MB (`term_history`). `since`: when history
/// was last turned on in the page (ms); a write from before the last clear is refused.
#[tauri::command]
async fn term_history_save(key: String, text: String, since: f64) -> Result<(), String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || term_history::save(&home, &key, &text, since)).await.map_err(|e| e.to_string())?
}

/// What terminal `key` showed before manut restarted, and when it was kept (seconds); null when nothing was.
#[tauri::command]
async fn term_history_read(key: String) -> Result<Option<(String, f64)>, String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || term_history::read(&home, &key)).await.map_err(|e| e.to_string())?
}

/// Remove terminal `key`'s kept text (it was closed).
#[tauri::command]
async fn term_history_remove(key: String) -> Result<(), String> {
    term_history::remove(&user_home()?, &key)
}

/// Remove the kept text of every terminal not in `keep` (manut started; the others are gone).
#[tauri::command]
async fn term_history_prune(keep: Vec<String>) -> Result<(), String> {
    term_history::prune(&user_home()?, &keep)
}

/// Remove every terminal's kept text (Settings › Terminal turned history off).
#[tauri::command]
async fn term_history_clear() -> Result<(), String> {
    term_history::clear(&user_home()?)
}

/// Settings › Terminal › Import from… (macOS): which of iTerm2 / Apple Terminal have a prefs file to read.
#[tauri::command]
async fn term_import_list() -> Result<Vec<&'static str>, String> {
    Ok(term_import::list(&user_home()?))
}

/// The profiles (names, colours, font) of `app` (`iterm2` | `terminal`), read once from its fixed prefs file.
#[tauri::command]
async fn term_import_read(app: String) -> Result<Vec<term_import::Profile>, String> {
    let app = term_import::App::parse(&app).ok_or("unknown app")?;
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || term_import::read(&home, app)).await.map_err(|e| e.to_string())?
}

/// A TERMINALS session's status file for bots holding its link (`~/.manut/terminals/<link>.json`, owner-only) and its
/// inbox folder (`term_share`). `status`: what the page shows of it (title, CLI, folder, state, last line).
#[tauri::command]
async fn term_share_write(link: String, status: term_share::Status) -> Result<(), String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || term_share::write(&home, &link, &status)).await.map_err(|e| e.to_string())?
}

/// Remove session `link`'s status file and inbox (it was closed).
#[tauri::command]
async fn term_share_remove(link: String) -> Result<(), String> {
    term_share::remove(&user_home()?, &link)
}

/// Remove the status files of every session not in `keep` (manut started; the others are gone).
#[tauri::command]
async fn term_share_prune(keep: Vec<String>) -> Result<(), String> {
    term_share::prune(&user_home()?, &keep)
}

/// Bots' requests to type into sessions `links`, each inbox file taken once (removed); refused files are removed
/// unread. The page shows each as a card: nothing is typed here.
#[tauri::command]
async fn term_share_take(links: Vec<String>) -> Result<Vec<term_share::Request>, String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || term_share::take(&home, &links).0).await.map_err(|e| e.to_string())
}

/// A lane's preview (preview.rs; the page's src/code/previewStore.ts): what the lane's own folder `cwd` holds for the page to
/// choose the start command from, its `package.json`, the names at its root and its `.env.example`. Only reads, and only in a
/// lane's own folder (`not_a_lane` for any other, the developer's own folder among them).
#[tauri::command]
async fn preview_read(cwd: String) -> Result<preview::Project, String> {
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || preview::read(&home, std::path::Path::new(&cwd))).await.map_err(|e| e.to_string())?
}

/// Start a lane's preview in its own folder `cwd`: `argv` is the command the page chose (`pnpm run dev`, one of the sixteen
/// preview.rs runs), `package` the `package.json` text it chose from (`changed` when the folder's is not that any more), and
/// `env` the secrets it runs with, each a sample unless the owner added it (`previewEnv`), over an environment that starts
/// empty. Its lines, and once its end, go to `on_event` (`{event:"lines", lines}`, `{event:"exit", code, stopped}`). The id it
/// answers names it to `preview_stop`. Refusals: `not_a_lane`, `bad_command`, `bad_env`, `changed`, `running`,
/// `missing:<manager>`, `unsupported`, or why the system would not start it.
#[tauri::command]
async fn preview_start(shell: State<'_, Shell>, cwd: String, argv: Vec<String>, package: String, env: Vec<(String, String)>, on_event: Channel<serde_json::Value>) -> Result<u32, String> {
    let home = user_home()?;
    let previews = shell.previews.clone();
    tauri::async_runtime::spawn_blocking(move || {
        previews.start(&home, std::path::Path::new(&cwd), &argv, &package, &env, move |out| {
            let _ = on_event.send(match out {
                preview::PreviewOut::Lines(lines) => serde_json::json!({"event": "lines", "lines": lines}),
                preview::PreviewOut::Exit { code, stopped } => serde_json::json!({"event": "exit", "code": code, "stopped": stopped}),
            });
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stop preview `id` and everything it started (its process group, as a chat's close stops a chat): `stopping`, or `gone`
/// when it had ended already.
#[tauri::command]
async fn preview_stop(shell: State<'_, Shell>, id: u32) -> Result<&'static str, String> {
    let previews = shell.previews.clone();
    tauri::async_runtime::spawn_blocking(move || previews.stop(id)).await.map_err(|e| e.to_string())
}

/// Stop every preview. The page calls this when it loads, with `session_close_all`: a preview whose page is gone would run on
/// unseen.
#[tauri::command]
async fn preview_close_all(shell: State<'_, Shell>) -> Result<(), String> {
    let previews = shell.previews.clone();
    tauri::async_runtime::spawn_blocking(move || previews.close_all()).await.map_err(|e| e.to_string())
}

/// A preview's Open: its address in the person's browser, through the system opener. Only an address of this computer, as
/// a dev server prints it (`http://localhost:5173/`), is sent; any other is refused (preview.rs `loopback_url`).
#[tauri::command]
async fn preview_open(url: String) -> Result<(), String> {
    if !preview::loopback_url(&url) {
        return Err("not an address of this computer".into());
    }
    system_open_url(&url)
}

/// Stop the chat's program and forget the session.
#[tauri::command]
async fn chat_close(shell: State<'_, Shell>, id: u32) -> Result<(), String> {
    shell.chats.close(id);
    Ok(())
}

/// Start Buddy's chat through `agent` (only Claude Code answers as Buddy, buddy_chat.rs) with Buddy's instructions
/// `prompt`, which the shell writes to a file of Buddy's own and passes by its path. Events come on `on_event` as for
/// `chat_start`, and once `{event:"exit", code, error}`. The chat runs as the account picked for new sessions of that
/// agent, else the CLI's own, in `~/.manut/buddy/chat`.
#[tauri::command]
async fn buddy_start(shell: State<'_, Shell>, agent: String, prompt: String, on_event: Channel<serde_json::Value>) -> Result<u32, String> {
    let buddy = shell.buddy.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let home = user_home()?;
        let account_env = accounts::session_env_for(&home, &agent, None);
        accounts::prepare(&home, &agent, &account_env);
        buddy_chat::start(&buddy, &home, &agent, &prompt, &account_env, move |out| {
            let _ = on_event.send(match out {
                ChatOut::Event(e) => e,
                ChatOut::Exit(code, error) => serde_json::json!({"event": "exit", "code": code, "error": error}),
            });
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What the person did in Buddy's chat `id`: a message (text only), Stop, the answer to an ask or a question, or one of
/// the chat box's choices, each checked against its fixed list (`buddy_chat::check`: an approval level of
/// `BUDDY_MODES`, Claude Code's own effort levels, a model this chat's Claude Code itself listed). Anything else is
/// refused.
#[tauri::command]
async fn buddy_input(shell: State<'_, Shell>, id: u32, input: agent_chat::Input) -> Result<(), String> {
    let buddy = shell.buddy.clone();
    tauri::async_runtime::spawn_blocking(move || {
        buddy_chat::check(&input, &buddy.models(id))?;
        buddy.input(id, input)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Save one file the person attached in Buddy's chat as `~/.manut/buddy/files/<n>-<name>` and return that path, which the
/// page names in the message (`buddy_chat::save_file`). The body is the file's bytes; the name comes percent-encoded in
/// `x-name`. Nothing else is written, and the agent asks before it reads the copy.
#[tauri::command]
async fn buddy_file_save(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let name = request.headers().get("x-name").and_then(|v| v.to_str().ok()).map(session_files::percent_decode).unwrap_or_default();
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else { return Err("expected the file's bytes".into()) };
    let data = data.clone();
    let home = user_home()?;
    tauri::async_runtime::spawn_blocking(move || buddy_chat::save_file(&home, &name, &data).map(|p| p.to_string_lossy().into_owned()))
        .await
        .map_err(|e| e.to_string())?
}

/// Stop Buddy's chat `id`.
#[tauri::command]
async fn buddy_close(shell: State<'_, Shell>, id: u32) -> Result<(), String> {
    shell.buddy.close(id);
    Ok(())
}

/// Stop every one of Buddy's chats: the page calls it before its first, since a reload keeps the shell and any chat
/// the page before it started.
#[tauri::command]
async fn buddy_close_all(shell: State<'_, Shell>) -> Result<(), String> {
    let buddy = shell.buddy.clone();
    tauri::async_runtime::spawn_blocking(move || buddy.close_all()).await.map_err(|e| e.to_string())
}

/// Stop every chat (the UI calls this when it loads, like `session_close_all`).
#[tauri::command]
async fn chat_close_all(shell: State<'_, Shell>) -> Result<(), String> {
    let chats = shell.chats.clone();
    tauri::async_runtime::spawn_blocking(move || chats.close_all()).await.map_err(|e| e.to_string())
}

/// A SESSIONS row's "Reveal": show the session's folder in the file manager (rule 30). Only an absolute path to a
/// folder that exists crosses from the page.
#[tauri::command]
async fn session_reveal(cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || folder_open::reveal(&cwd)).await.map_err(|e| e.to_string())?
}

/// A SESSIONS row's "Open in Terminal": the person's own system terminal, in the session's folder, running their
/// shell with nothing typed into it (rule 30).
#[tauri::command]
async fn session_open_terminal(cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || folder_open::open_terminal(&cwd)).await.map_err(|e| e.to_string())?
}

/// The home a session of `agent` reads its conversations from: the account it ran with (`account`), else the account
/// picked for new sessions, else the CLI's own (rule 30). An `account` whose folder is gone is an error, not another
/// home: its conversation is not known to be missing, only out of reach.
fn past_home(agent: &str, account: Option<&str>) -> Result<PathBuf, String> {
    past_home_in(&user_home()?, agent, account, &|k| std::env::var(k).ok())
}

/// [`past_home`] for the user's home `home` and environment `var`.
fn past_home_in(home: &std::path::Path, agent: &str, account: Option<&str>, var: &dyn Fn(&str) -> Option<String>) -> Result<PathBuf, String> {
    if !past_chats::lists(agent) {
        return Err(format!("{agent} conversations are not listed"));
    }
    if let (Some(id), Some(cli)) = (account.filter(|a| *a != "default"), accounts::session_cli(agent)) {
        if !accounts::account_dir(home, cli, id).map(|d| d.is_dir() && !d.is_symlink()).unwrap_or(false) {
            return Err("its account folder is gone".into());
        }
    }
    let env = accounts::session_env_for(home, agent, account);
    past_chats::cli_home(home, agent, &env, var).ok_or_else(|| "no home".to_string())
}

/// The recent conversations Claude Code or Codex keeps for `cwds` (the + menu's folders), read-only (rule 30).
#[tauri::command]
async fn past_chats_list(agent: String, cwds: Vec<String>) -> Result<Vec<past_chats::PastChat>, String> {
    tauri::async_runtime::spawn_blocking(move || past_chats::list(&past_home(&agent, None)?, &agent, &cwds)).await.map_err(|e| e.to_string())?
}

/// The conversation the Codex in the foreground of TERMINALS session `id` holds open, for the session to continue
/// after a restart (rule 11): only the id, checked as a UUID, from a rollout path inside the session's Codex home
/// (rule 30's checks). The page sends only the session id.
#[tauri::command]
async fn codex_conversation(shell: State<'_, Shell>, id: u32) -> Result<Option<String>, String> {
    let sessions = shell.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || Ok(sessions.codex_conversation(id, &user_home()?).filter(|c| sessions::is_uuid(c))))
        .await
        .map_err(|e| e.to_string())?
}

/// The last messages of one of those conversations, shown before the agent continues it (rule 30).
#[tauri::command]
async fn past_chat_messages(agent: String, id: String, cwd: String) -> Result<Vec<past_chats::PastMsg>, String> {
    tauri::async_runtime::spawn_blocking(move || past_chats::messages(&past_home(&agent, None)?, &agent, &id, &cwd)).await.map_err(|e| e.to_string())?
}

/// Whether the file of a TERMINALS Claude Code or Codex session's own conversation `id` exists, asked before the
/// session continues it (rule 30): `exists`, `absent`, or `unknown`, in the home of the account it runs with
/// (`account`). Only names are looked at. An account whose folder is gone, or a home that cannot be read, is
/// `unknown`: the conversation is out of reach, not known to be missing.
#[tauri::command]
async fn conversation_state(agent: String, id: String, account: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !past_chats::lists(&agent) {
            return Err(format!("{agent} conversations are not listed"));
        }
        match past_home(&agent, account.as_deref()) {
            Ok(home) => past_chats::conversation_state(&home, &agent, &id).map(str::to_string),
            Err(_) => Ok("unknown".to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// How many asks wait on the person, on the Dock icon (macOS) or the launcher entry (Linux desktops that show
/// counts); Windows has no count, so its taskbar button gets a small amber dot. 0 clears it.
#[tauri::command]
async fn asks_badge(window: tauri::WebviewWindow, count: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        let icon = if count > 0 {
            let (rgba, n) = folder_open::overlay_dot();
            Some(tauri::image::Image::new_owned(rgba, n, n))
        } else {
            None
        };
        window.set_overlay_icon(icon).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        window.set_badge_count(if count > 0 { Some(i64::from(count)) } else { None }).map_err(|e| e.to_string())
    }
}

/// Close the window: the page's answer to Close Window (⌘W) when no split pane has the keyboard (app_menu.rs).
#[tauri::command]
fn window_close(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

/// Settings › General "Keep the computer awake while agents work": the page's busy/idle edge (never one per output).
/// `now`: the setting was turned off, so an idle edge lets go at once instead of a minute later (power.rs).
#[tauri::command]
fn power_busy(power: State<'_, power::Power>, busy: bool, now: Option<bool>) {
    power.busy(busy, now.unwrap_or(false));
}

/// Settings › General "When the window closes": whether the close hides the window to the tray (the tray icon shows
/// only then), and the tray menu's two labels in the page's language (tray.rs).
#[tauri::command]
fn window_prefs(app: AppHandle, hide: bool, open: Option<String>, quit: Option<String>) {
    let tray = app.try_state::<tray::TrayMenu<tauri::Wry>>();
    // no tray icon (it could not be made): the close keeps quitting, or the window could not come back
    if let Some(s) = app.try_state::<tray::TrayState>() {
        s.set_hides(hide && tray.is_some());
    }
    if let Some(t) = tray {
        t.apply(hide, open.as_deref().unwrap_or(""), quit.as_deref().unwrap_or(""));
    }
}

/// `manut --statusline-relay <account>` (a TERMINALS Claude Code's status line, `claude_usage.rs`): records the usage
/// Claude Code reports, runs the person's own status line and returns its exit code. No app start-up happens.
/// `manut --computer-mcp`: a chat's Claude Code runs this program as computer use's MCP server, which relays each call to
/// the running app (computer/mcp.rs). Handled before anything of the app starts, as the status line relay is.
pub fn computer_relay(args: &[std::ffi::OsString]) -> Option<i32> {
    if args.get(1)?.to_str()? != computer::mcp::FLAG {
        return None;
    }
    Some(computer::mcp::relay_main())
}

pub fn statusline_relay(args: &[std::ffi::OsString]) -> Option<i32> {
    if args.get(1)?.to_str()? != claude_usage::RELAY_FLAG {
        return None;
    }
    Some(claude_usage::relay_main(args))
}

pub fn run() {
    let builder = tauri::Builder::default();
    // macOS: Close Window (⌘W) asks the page first, so a split pane closes instead of the window (app_menu.rs). Other
    // systems keep no menu, as before.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(|app| app_menu::build(app));
    // Windows and Linux: first, so a second launch carrying an manut:// link hands it over and quits
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }));
    let app = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        // In-app updates: the page checks the one endpoint in tauri.conf.json, which moves only when the owner publishes
        // a release, and installs only a build signed with the key whose public half is pinned there (docs/releasing.md).
        // The process plugin does the restart that follows an update.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // The app's window keeps to the app's own pages and this computer's addresses, frames included (preview.rs)
        .plugin(app_window_guard())
        .on_menu_event(|app, event| {
            if app_menu::is_close(event.id().as_ref()) {
                let _ = app.emit(app_menu::CLOSE_EVENT, ());
            }
        })
        // the window's close hides it while Settings › General says so (tray.rs); a main window that is really gone
        // stops this Mac's outpost and closes its window, so the app can end (outpost/mod.rs)
        .on_window_event(|window, event| {
            tray::window_event(window, event);
            outpost::window_event(window, event);
        })
        // The outpost's window shows the shop's sites, never the app: every command from it is refused here, before
        // Tauri's own check is even asked (outpost/browser.rs).
        .invoke_handler(move |invoke| {
            if outpost::is_outpost_webview(invoke.message.webview_ref().label()) {
                invoke.resolver.reject("not allowed");
                return true;
            }
            commands(invoke)
        })
        .setup(|app| {
            app.manage(outpost::Outposts::new(app.handle().clone()));
            app.manage(Arc::new(tasks::Tasks::default()));
            app.manage(Arc::new(gh_me::Me::default()));
            // the asks that push a lane and open or merge its pull request, each settled once (review.rs)
            app.manage(Arc::new(review::Ledger::default()));
            app.manage(Arc::new(skill_links::Installs::default()));
            // free space on the home folder's volume, read once a minute (disk.rs)
            app.manage(disk::Disk::start(app.handle().clone(), user_home().ok()));
            // close = hide to the tray / menu bar, and the keep-awake assertion's worker (tray.rs, power.rs)
            app.manage(tray::TrayState::default());
            app.manage(power::Power::start());
            if let Err(e) = tray::build(app.handle()) {
                // no tray (a Linux desktop without one): the close quits, as before
                app.state::<tray::TrayState>().set_hides(false);
                eprintln!("Manut AI: no tray icon: {e}");
            }
            // manut://terminal/<id> links: the one manut was opened with, and each one after
            app.manage(term_link::TermLinks::default());
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Windows and Linux: an installed build registers the scheme itself; a portable run (AppImage) does it here
                #[cfg(any(target_os = "windows", target_os = "linux"))]
                let _ = app.deep_link().register_all();
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    let urls: Vec<String> = urls.iter().map(|u| u.to_string()).collect();
                    term_link::arrived(app.handle(), &urls);
                }
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
                    term_link::arrived(&handle, &urls);
                });
            }
            // computer use (computer/hub.rs): the socket the chats' MCP servers reach and the skill Claude Code is handed.
            // Without it a chat simply gets no computer use; nothing else depends on it.
            #[cfg(target_os = "macos")]
            if let Ok(home) = user_home() {
                if let Err(e) = computer::hub::start(&home) {
                    eprintln!("Manut AI: no computer use: {e}");
                }
            }
            app.manage(Shell {
                logins: accounts::Logins::new(),
                sessions: Sessions::new(),
                chats: ChatSessions::new(),
                buddy: ChatSessions::new(),
                previews: preview::Previews::new(),
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Manut AI");

    app.run(|handle, event| {
        // macOS: the Dock icon of a hidden manut shows the window again
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = event {
            tray::show_main(handle);
        }
        if let RunEvent::Exit = event {
            // this Mac's outpost stops, and its window closes
            outpost::shutdown(handle);
            if let Some(power) = handle.try_state::<power::Power>() {
                power.quit();
            }
            if let Some(shell) = handle.try_state::<Shell>() {
                shell.sessions.close_all();
                shell.chats.close_all();
                shell.buddy.close_all();
                shell.previews.close_all();
                shell.logins.cancel_all();
            }
            // the sessions are gone: so are the status files bots read
            if let Ok(home) = user_home() {
                let _ = term_share::prune(&home, &[]);
            }
        }
    });
}

/// The label of the app's own window (tauri.conf.json's window, which names none).
const MAIN: &str = "main";

/// The app's window loads only its own pages, empty frames and pages on this computer's addresses (preview.rs
/// `app_window_may_load`): the frame beside a lane shows a preview's page there, and a link in that page to another site, or
/// anything that would take the window away from the app, is cancelled. The shell's second look at what the frame shows,
/// after the page's own (src/code/previewFrame.ts) and beside the CSP's `frame-src`, which WebKit applies first. Only the
/// main window: the outpost's has its own guard (outpost/browser.rs), which is asked before this one.
fn app_window_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("app-window")
        .on_navigation(|webview, url| webview.label() != MAIN || preview::app_window_may_load(url.as_str()))
        .build()
}

/// Every command the page may call (`invoke_handler` in `run` refuses them all to the outpost's window).
fn commands(invoke: tauri::ipc::Invoke) -> bool {
    let answer: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![
        open_external,
        account_env,
        account_clis,
        account_status,
        account_version,
        account_login_start,
        account_login_cancel,
        accounts_list,
        accounts_add,
        accounts_set_active,
        accounts_label,
        accounts_remove,
        accounts_discard,
        providers_list,
        provider_save,
        provider_version,
        sessions_agents,
        custom_agents_list,
        custom_agent_preview,
        custom_agent_bot_preview,
        custom_agent_confirm,
        custom_agent_remove,
        session_start,
        shell_start,
        shells_available,
        session_write,
        session_ack,
        session_resize,
        session_close,
        session_close_all,
        chat_start,
        chat_input,
        chat_close,
        session_file_save,
        session_file_read,
        session_files_remove,
        session_files_prune,
        term_history_save,
        term_history_read,
        term_history_remove,
        term_history_prune,
        term_history_clear,
        term_import_list,
        term_import_read,
        term_share_write,
        term_share_remove,
        term_share_prune,
        term_share_take,
        session_branch,
        lane_worktree,
        lane_list,
        lane_projects,
        lane_remove,
        lane_root_check,
        workflows_read,
        workflows_folder,
        agent_config_list,
        skill_bundle_read,
        skill_link_read,
        skill_install_ask,
        skill_install_settle,
        skill_install_withdraw,
        lane_release,
        lane_clean_merged,
        source_pull,
        review_draft,
        review_ask_open,
        review_ask_merge,
        review_settle,
        review_withdraw,
        session_main_moved,
        lane_diff,
        chat_close_all,
        buddy_start,
        buddy_input,
        buddy_file_save,
        buddy_close,
        buddy_close_all,
        session_reveal,
        session_open_terminal,
        past_chats_list,
        past_chat_messages,
        conversation_state,
        codex_conversation,
        running_list,
        running_stop,
        preview_read,
        preview_start,
        preview_stop,
        preview_close_all,
        preview_open,
        host_name,
        asks_badge,
        tasks_status,
        tasks_list,
        tasks_view,
        tasks_remote,
        gh_accounts,
        source_tools,
        tasks_me,
        gh_login_start,
        window_close,
        power_busy,
        window_prefs,
        api_request,
        api_session_read,
        api_session_write,
        api_session_clear,
        shop_cache_write,
        shop_cache_read,
        shop_cache_clear,
        shop_cache_seal_key,
        shop_cache_seal_key_clear,
        term_link::term_link_take,
        disk::disk_watch,
        turn_files::turn_files_take,
        turn_files::turn_files_end,
        turn_files::turn_files_preview,
        turn_files::turn_files_restore,
        turn_files::turn_files_settle,
        turn_files::turn_files_back_preview,
        turn_files::turn_files_bring_back,
        turn_files::turn_files_forget,
        turn_files::turn_files_prune,
        outpost::outpost_status,
        outpost::outpost_signed_in,
        outpost::outpost_signed_out,
        outpost::outpost_run,
        outpost::outpost_register,
        voice::voice_status,
        voice::voice_listen,
        voice::voice_stop,
        computer::computer_status,
        computer::computer_open
    ];
    answer(invoke)
}

#[cfg(test)]
mod tests {
    use super::{allowed_external, past_home_in};

    #[test]
    fn a_session_account_whose_folder_is_gone_is_not_read_elsewhere() {
        let home = std::env::temp_dir().join(format!("manut-past-home-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let work = home.join(".manut").join("accounts").join("claude").join("work");
        std::fs::create_dir_all(&work).unwrap();
        let none = |_: &str| None;
        // the account it ran with, while its folder is there
        assert_eq!(past_home_in(&home, "claude", Some("work"), &none), Ok(work.clone()));
        // gone: an error, not the home new sessions use
        assert_eq!(past_home_in(&home, "claude", Some("gone"), &none), Err("its account folder is gone".to_string()));
        std::fs::remove_dir_all(&work).unwrap();
        assert_eq!(past_home_in(&home, "claude", Some("work"), &none), Err("its account folder is gone".to_string()));
        // "This computer", or none saved: the CLI's own home
        assert_eq!(past_home_in(&home, "claude", Some("default"), &none), Ok(home.join(".claude")));
        assert_eq!(past_home_in(&home, "codex", None, &none), Ok(home.join(".codex")));
        assert!(past_home_in(&home, "grok", None, &none).is_err());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn only_the_relay_flag_as_the_first_argument_skips_the_app() {
        let args = |a: &[&str]| a.iter().map(std::ffi::OsString::from).collect::<Vec<_>>();
        for other in [&["manut"][..], &["manut", "manut://terminal/abcdefgh23"], &["manut", "--statusline-relayx"], &["manut", "x", "--statusline-relay"]] {
            assert_eq!(super::statusline_relay(&args(other)), None, "{other:?}");
        }
    }

    #[test]
    fn opens_thread_links_and_a_lookalike_only_as_a_web_page() {
        assert!(allowed_external("slack://channel?team=T1&id=C1&thread_ts=1.2"));
        assert!(allowed_external("https://discord.com/channels/1/2"));
        // a lookalike is an ordinary web link: it opens in the browser, never in the Discord app
        assert!(allowed_external("https://evil.example/discord.com/channels/1"));
        assert_eq!(super::discord_app_url("https://evil.example/discord.com/channels/1"), None);
        assert!(!allowed_external("slack://open?team=T1"));
        assert!(!allowed_external("discord://evil.example/channels/1"));
        assert!(!allowed_external("file:///etc/passwd"));
        assert!(!allowed_external("https://discord.com/channels/1 --args"));
        assert!(!allowed_external("javascript:alert(1)"));
    }

    #[test]
    fn opens_a_github_pull_request_and_nothing_else_on_github() {
        assert!(allowed_external("https://github.com/rlaope/oh-my-hermes/pull/2746"));
        assert!(allowed_external("https://github.com/o-1/r_e.po/pull/1"));
        for bad in [
            "https://github.com/rlaope/oh-my-hermes/pull/2746/files",
            "https://github.com/rlaope/oh-my-hermes/pull/2746?x=1",
            "https://github.com/rlaope/oh-my-hermes/issues/2746",
            "https://github.com/rlaope/oh-my-hermes/pull/",
            "https://github.com/rlaope/oh-my-hermes/pull/27x",
            "https://github.com/rlaope/../pull/1",
            "https://github.com/_x/r/pull/1",
            "https://github.com.evil.example/o/r/pull/1",
            "http://github.com/o/r/pull/1",
            "https://github.com/o/r/pull/1 --args",
            "https://github.com/settings/tokens",
        ] {
            assert!(!super::github_pr_url(bad), "{bad}");
        }
        // a plan node's PR page is also a web link, so a chip opens the same address
        assert!(allowed_external("https://github.com/rlaope/oh-my-hermes/pull/2746/files"));
    }

    #[test]
    fn opens_web_links_from_link_chips_and_nothing_else() {
        assert!(allowed_external("https://github.com/rlaope/oh-my-hermes/pull/2657"));
        assert!(allowed_external("https://sionicai.slack.com/archives/C0BLC924P1P/p1794195216893139"));
        assert!(allowed_external("http://example.com"));
        assert!(allowed_external("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=83s"));
        assert!(!allowed_external("https://github.com@evil.io/x"));
        assert!(!allowed_external("https://user:pw@example.com/"));
        assert!(!allowed_external("https:///etc/passwd"));
        assert!(!allowed_external("https://"));
        assert!(!allowed_external("ftp://example.com/x"));
        assert!(!allowed_external("vscode://file/etc/passwd"));
        assert!(!allowed_external("https://example.com/a b"));
        assert!(!allowed_external("https://example.com/\nx"));
        assert!(!allowed_external("HTTPS://example.com/"));
        assert!(!allowed_external("https:\\\\evil.io\\x"));
    }

    /// The names of the commands the page may call, as `commands` lists them (the last part of each path).
    fn command_names() -> Vec<String> {
        let src = include_str!("lib.rs");
        let list = &src[src.find("fn commands(").unwrap()..];
        let list = &list[list.find("generate_handler![").unwrap() + "generate_handler![".len()..];
        let list = &list[..list.find("];").unwrap()];
        list.split(',').map(str::trim).filter(|s| !s.is_empty()).map(|s| s.rsplit("::").next().unwrap().to_string()).collect()
    }

    type MockApp = (tauri::App<tauri::test::MockRuntime>, tauri::WebviewWindow<tauri::test::MockRuntime>, std::sync::Arc<std::sync::Mutex<Vec<String>>>);

    /// The app's own capabilities and config (tauri.conf.json, capabilities/), in Tauri's mock runtime, with a stand-in for
    /// every command that answers `ran` and notes its name, and the app's window, which the capability names (a mock build
    /// makes no window of the config's).
    fn mock_app() -> MockApp {
        let ran = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let noted = ran.clone();
        let app = tauri::test::mock_builder()
            .invoke_handler(move |invoke| {
                noted.lock().unwrap().push(invoke.message.command().to_string());
                invoke.resolver.resolve("ran");
                true
            })
            .build(tauri::generate_context!(test = true))
            .unwrap();
        let main = tauri::WebviewWindowBuilder::new(&app, super::MAIN, Default::default()).build().unwrap();
        (app, main, ran)
    }

    #[test]
    fn a_framed_pages_call_reaches_no_command_or_plugin_of_the_app() {
        use tauri::ipc::{CallbackFn, InvokeBody};
        use tauri::webview::InvokeRequest;
        let (_app, main, ran) = mock_app();
        // What Tauri's own `on_message` answers a call from a page at `origin`: the origin it was asked from is the frame's
        // own (wry reads the frame of a message, WebKit sends the frame's Origin with an ipc:// request), and the call
        // carries the key, which a framed page never has on macOS and Linux (Tauri's scripts are the main frame's alone),
        // so this is the next check: the one a page that somehow had the key would meet.
        let call = |cmd: &str, origin: &str| {
            tauri::test::get_ipc_response(
                &main,
                InvokeRequest {
                    cmd: cmd.into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: origin.parse().unwrap(),
                    body: InvokeBody::default(),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.to_string(),
                },
            )
        };
        let names = command_names();
        assert!(names.len() >= 90, "{}", names.len());
        for name in ["preview_open", "preview_start", "open_external", "api_request", "chat_start"] {
            assert!(names.iter().any(|n| n == name), "{name}");
        }
        // The app's own page reaches each command and a core plugin: the refusals below are the origin's alone.
        for name in &names {
            assert!(call(name, "tauri://localhost").is_ok(), "{name}");
        }
        assert!(call("plugin:app|version", "tauri://localhost").is_ok());
        assert_eq!(ran.lock().unwrap().len(), names.len());
        // A page at a preview's address, framed or not, reaches none of them and no plugin: no capability names a remote page.
        let plugins = ["plugin:app|version", "plugin:event|listen", "plugin:event|emit", "plugin:window|show", "plugin:window|set_focus",
            "plugin:window|set_badge_count", "plugin:webview|print", "plugin:path|resolve_directory", "plugin:notification|notify",
            "plugin:dialog|open", "plugin:process|restart", "plugin:opener|open_url"];
        for origin in ["http://localhost:5173/", "https://localhost:3000/", "http://127.0.0.1:8080/", "http://[::1]:5173/", "https://example.com/"] {
            for name in names.iter().map(String::as_str).chain(plugins) {
                let refused = call(name, origin).expect_err(name);
                assert!(refused.to_string().contains("not allowed"), "{name} from {origin}: {refused}");
            }
        }
        assert_eq!(ran.lock().unwrap().len(), names.len(), "a refused call ran a command");
        // A debug build's own dev server is the app's page to Tauri: the page never frames the app's own origin
        // (previewFrame.ts `own`), since a frame there would be the app.
        assert!(call("preview_open", "http://localhost:5207/").is_ok());
        // Tauri lets any page with the key fetch a channel's data (FETCH_CHANNEL_DATA_COMMAND skips the check), so only the
        // key keeps a frame from it: on Windows, where every script reaches every frame, the page frames nothing.
        assert_eq!(call("plugin:__TAURI_CHANNEL__|fetch", "http://localhost:5173/").unwrap_err(), serde_json::json!("missing channel id header"));
    }

    #[test]
    fn the_app_window_guard_cancels_another_site_in_the_main_window_and_leaves_the_outpost_to_its_own() {
        use tauri::plugin::Plugin;
        let (app, main, _) = mock_app();
        let outpost = tauri::WebviewWindowBuilder::new(&app, "outpost", Default::default()).build().unwrap();
        assert!(crate::outpost::is_outpost_webview(outpost.label()));
        let mut guard = super::app_window_guard::<tauri::test::MockRuntime>();
        let url = |u: &str| tauri::Url::parse(u).unwrap();
        for ok in ["tauri://localhost", "http://localhost:5173/checkout", "about:blank"] {
            assert!(guard.on_navigation(main.as_ref(), &url(ok)), "{ok}");
        }
        for bad in ["https://example.com/", "http://192.168.1.5:5173/", "tauri://evil.example/", "file:///etc/passwd"] {
            assert!(!guard.on_navigation(main.as_ref(), &url(bad)), "{bad}");
        }
        // the outpost's window shows the shop's sites: its own guard decides, and this one lets it be
        assert!(guard.on_navigation(outpost.as_ref(), &url("https://example.com/")));
    }

    #[test]
    fn discord_links_go_to_the_app_first() {
        use super::discord_app_url;
        assert_eq!(
            discord_app_url("https://discord.com/channels/1544/1568").as_deref(),
            Some("discord://discord.com/channels/1544/1568")
        );
        assert!(allowed_external(&discord_app_url("https://discord.com/channels/1/2").unwrap()));
        assert_eq!(discord_app_url("slack://channel?team=T1&id=C1"), None);
        assert_eq!(discord_app_url("https://t.me/x"), None);
    }
}
