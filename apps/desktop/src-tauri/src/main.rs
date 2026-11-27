#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    // the Mac App Store edition: HOME becomes the person's real home, not the sandbox's container, before any thread or
    // child exists (app_store.rs); the GitHub build does nothing here
    manut_lib::adopt_real_home();
    // a TERMINALS Claude Code's status line runs this binary as a relay: handled before anything of the app starts
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if let Some(code) = manut_lib::statusline_relay(&args) {
        std::process::exit(code);
    }
    // a chat's Claude Code runs this binary as computer use's MCP server (computer/mcp.rs): also before the app starts
    if let Some(code) = manut_lib::computer_relay(&args) {
        std::process::exit(code);
    }
    // another program runs this binary as the MCP server for the chats the person listed (threads_mcp/relay.rs)
    if let Some(code) = manut_lib::threads_relay(&args) {
        std::process::exit(code);
    }
    manut_lib::run()
}
