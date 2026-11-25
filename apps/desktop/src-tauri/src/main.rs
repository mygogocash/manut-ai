#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    // a TERMINALS Claude Code's status line runs this binary as a relay: handled before anything of the app starts
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if let Some(code) = manut_lib::statusline_relay(&args) {
        std::process::exit(code);
    }
    // a chat's Claude Code runs this binary as computer use's MCP server (computer/mcp.rs): also before the app starts
    if let Some(code) = manut_lib::computer_relay(&args) {
        std::process::exit(code);
    }
    manut_lib::run()
}
