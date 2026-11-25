//! What a coding agent asked to do, read from the agent's own message: `tool` on an `approval.request` (`AskTool` in
//! src/lib/protocol.ts), which Kit's dial reads on the page (src/code/ask.ts).
//!
//! An ask's title and command are for the person. The title is a sentence the shell made ("Run this command?", "Allow
//! Edit to change src/a.ts?"), and the command is cut to one short line, so a command written on two lines reads there
//! as one other command, and a long list of files is cut short. Kit's dial must not decide from those words. So each
//! adapter also names, from what the agent itself sent:
//!
//! - `kind`: `command`, `edit`, `write`, `read` (a file read, or a search in a folder), `delete`, `fetch` or `other`;
//! - `name`: the agent's own name for the tool (`Bash`, `Edit`, `write`);
//! - `line`: a command's whole line as the agent runs it, never cut and with its line breaks;
//! - `paths`: every path the step names, as the agent wrote it;
//! - `cwd`: the folder the step runs in;
//! - `server`: for an MCP tool, the server it belongs to (`mcp__<server>__<tool>`), shown only and never decided on.
//!
//! A part that cannot be read whole is left out, and the dial then asks the person, as every ask did before it. A
//! command line can hold a key: this goes to the page and nowhere else, the page masks keys wherever it shows a
//! command, and nothing here logs a line or puts one in an error.

use std::path::Path;

use serde_json::{json, Value};

/// The longest command line an ask carries. A longer one is left out: the dial asks rather than read part of it.
const LINE_CHARS: usize = 10_000;
/// The most paths an ask carries, and the longest path. A step that names more, or a longer one, carries none, since
/// a list the dial cannot read whole is not read at all.
const MAX_PATHS: usize = 200;
const PATH_CHARS: usize = 4_096;
/// The longest tool name kept. A name is only shown, never decided on.
const NAME_CHARS: usize = 120;

/// `tool` for an ask. Each part that is missing, empty or too long is left out; `kind` is always there.
pub(crate) fn ask_tool(kind: &str, name: &str, line: Option<&str>, paths: Option<Vec<String>>, cwd: &str) -> Value {
    let mut t = json!({ "kind": kind });
    let name = name.trim();
    if !name.is_empty() {
        t["name"] = Value::String(name.chars().take(NAME_CHARS).collect());
    }
    if let Some(l) = line.filter(|l| !l.trim().is_empty() && l.chars().count() <= LINE_CHARS) {
        t["line"] = Value::String(l.to_string());
    }
    if let Some(p) = paths.filter(|p| !p.is_empty() && p.len() <= MAX_PATHS && p.iter().all(|x| !x.trim().is_empty() && x.chars().count() <= PATH_CHARS)) {
        t["paths"] = json!(p);
    }
    if !cwd.trim().is_empty() {
        t["cwd"] = Value::String(cwd.to_string());
    }
    t
}

/// `v`'s text field `k`, when it is text and not blank.
fn text<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str).filter(|x| !x.trim().is_empty())
}

/// Adds `p` to `paths` unless it is there already.
fn push_new(paths: &mut Vec<String>, p: &str) {
    if !paths.iter().any(|x| x == p) {
        paths.push(p.to_string());
    }
}

/// A glob pattern that stays inside the folder it is matched from: not absolute, not from `~`, and no `..` part.
fn stays_under(pattern: &str) -> bool {
    let p = pattern.trim();
    let absolute = p.starts_with('/') || p.starts_with('\\') || p.starts_with('~') || p.get(1..2) == Some(":");
    !absolute && !p.split(['/', '\\']).any(|part| part == "..")
}

/// The folder a command runs in when its own arguments name one (`cwd`, `workdir` or `directory`, read from the
/// session's folder when relative), else the session's folder, where the agent was started.
fn run_folder(args: &Value, session: &str) -> String {
    match ["cwd", "workdir", "directory"].into_iter().find_map(|k| text(args, k)) {
        Some(d) => Path::new(session).join(d).to_string_lossy().into_owned(),
        None => session.to_string(),
    }
}

/// The ask's `tool` for a Claude Code permission request (`can_use_tool`), from its `tool_name` and `input`. Claude
/// Code's file tools name absolute paths. The path Claude Code itself found the step reaching outside its folders
/// (`blocked_path`) is named too, for a command as well, so a path its line does not show plainly is still checked.
///
/// A command runs where Claude Code's shell is: the session's folder, unless an earlier command moved it with `cd`
/// inside the folders Claude Code may use, which the request does not say. `cwd` is the session's folder.
///
/// A command that asks to run outside Claude Code's sandbox (`dangerouslyDisableSandbox`) is `other`: lifting the
/// sandbox is the person's to allow, as the shell offers no mode that lifts it.
pub(crate) fn claude_tool(name: &str, input: &Value, blocked: &str, cwd: &str) -> Value {
    let with_blocked = |mut paths: Vec<String>| {
        if !blocked.trim().is_empty() {
            push_new(&mut paths, blocked);
        }
        paths
    };
    let file = |k: &str| text(input, k).map(|p| with_blocked(vec![p.to_string()]));
    let unsandboxed = input.get("dangerouslyDisableSandbox").and_then(Value::as_bool) == Some(true);
    let (kind, line, paths) = match name {
        "Bash" if unsandboxed => ("other", None, None),
        "Bash" => ("command", text(input, "command"), Some(with_blocked(vec![]))),
        "Edit" | "MultiEdit" => ("edit", None, file("file_path")),
        "NotebookEdit" => ("edit", None, file("notebook_path")),
        "Write" => ("write", None, file("file_path")),
        "Read" => ("read", None, file("file_path")),
        "NotebookRead" => ("read", None, file("notebook_path")),
        "LS" | "Grep" => ("read", None, file("path")),
        // a pattern from the root or from `~`, or one that climbs out with `..`, reaches past the folder searched
        "Glob" => ("read", None, text(input, "pattern").filter(|p| stays_under(p)).and_then(|_| file("path"))),
        "WebFetch" => ("fetch", None, None),
        _ => ("other", None, None),
    };
    let mut t = ask_tool(kind, name, line, paths, cwd);
    // an MCP tool (`mcp__<server>__<tool>`) also names its server, which the card and Needs you show beside the tool
    if let Some((server, _)) = crate::agent_chat::mcp_parts(name) {
        t["server"] = Value::String(server.chars().take(NAME_CHARS).collect());
    }
    t
}

/// A command line split into words the way a POSIX shell splits it, or `None` when it holds anything but plain
/// words: an unquoted `$`, backtick, `;`, `&`, `|`, `<`, `>`, `(`, `)`, glob or brace, a `~` or `#` starting a word, a
/// line break, a `$` or backtick inside double quotes, or a quote that is not closed. It is used only to take the
/// script out of a `sh -c '…'` wrapper exactly, so it refuses rather than guesses.
fn sh_words(t: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut chars = t.chars();
    while let Some(c) = chars.next() {
        match c {
            ' ' | '\t' => {
                if in_word {
                    words.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            '\'' => {
                in_word = true;
                loop {
                    match chars.next()? {
                        '\'' => break,
                        x => cur.push(x),
                    }
                }
            }
            '"' => {
                in_word = true;
                loop {
                    match chars.next()? {
                        '"' => break,
                        '\\' => match chars.next()? {
                            x @ ('"' | '\\' | '$' | '`') => cur.push(x),
                            '\n' => {}
                            x => {
                                cur.push('\\');
                                cur.push(x);
                            }
                        },
                        '$' | '`' => return None,
                        x => cur.push(x),
                    }
                }
            }
            '\\' => {
                in_word = true;
                match chars.next()? {
                    '\n' => {}
                    x => cur.push(x),
                }
            }
            '$' | '`' | ';' | '&' | '|' | '<' | '>' | '(' | ')' | '*' | '?' | '[' | '{' | '}' => return None,
            '#' | '~' if !in_word => return None,
            x if x.is_control() => return None,
            x => {
                in_word = true;
                cur.push(x);
            }
        }
    }
    if in_word {
        words.push(cur);
    }
    Some(words)
}

/// The command line a Codex command approval runs: the script of its `sh -c` wrapper (`/bin/zsh -lc 'mkdir -p d1'`),
/// taken out exactly, or the command as Codex sent it when it is no wrapper. `None` for a wrapper that is not one
/// plainly quoted script (more words after it, an expansion in it), whose script cannot be known for sure.
fn codex_line(raw: &str) -> Option<String> {
    let t = raw.trim();
    let first = t.split_whitespace().next()?;
    let program = first.rsplit(['/', '\\']).next().unwrap_or(first);
    if !matches!(program, "sh" | "bash" | "zsh") {
        return Some(t.to_string());
    }
    match sh_words(t)?.as_slice() {
        [_, flag, script] if matches!(flag.as_str(), "-c" | "-lc" | "-lic" | "-ic") && !script.trim().is_empty() => Some(script.clone()),
        _ => None,
    }
}

/// The ask's `tool` for a Codex command approval (`item/commandExecution/requestApproval`): the line Codex runs, in
/// the folder Codex names for it (`cwd`, else the session's). A request of another `kind` than `command` is `other`.
pub(crate) fn codex_command_tool(p: &Value, session: &str) -> Value {
    if p.get("kind").and_then(Value::as_str).is_some_and(|k| k != "command") {
        return ask_tool("other", "", None, None, session);
    }
    let cwd = text(p, "cwd").unwrap_or(session);
    let line = p.get("command").and_then(Value::as_str).and_then(codex_line);
    ask_tool("command", "", line.as_deref(), None, cwd)
}

/// What a Codex file change names, from its `fileChange` item: each change's path and the path a move takes the file
/// to, and whether it deletes a file. `None` when a change names no path or is of a kind not known here (`add`,
/// `update`, `delete`), since a list read in part is not read at all.
pub(crate) fn codex_change(item: &Value) -> Option<(Vec<String>, bool)> {
    let changes = item.get("changes")?.as_array()?;
    let mut paths = Vec::new();
    let mut deletes = false;
    for c in changes {
        push_new(&mut paths, text(c, "path")?);
        let kind = c.get("kind");
        match kind.and_then(|k| k.as_str().or_else(|| text(k, "type")))? {
            "add" | "update" => {}
            "delete" => deletes = true,
            _ => return None,
        }
        for to in ["move_path", "movePath"].into_iter().filter_map(|k| kind.and_then(|x| text(x, k))) {
            push_new(&mut paths, to);
        }
    }
    (!paths.is_empty()).then_some((paths, deletes))
}

/// The ask's `tool` for a Codex file change approval (`item/fileChange/requestApproval`): the paths of its item, read
/// when the item started (`codex_change`), and the folder Codex asks to write under for the rest of the session
/// (`grantRoot`), when it names one. Codex names absolute paths.
pub(crate) fn codex_change_tool(change: Option<&(Vec<String>, bool)>, p: &Value, cwd: &str) -> Value {
    let Some((paths, deletes)) = change else { return ask_tool("edit", "", None, None, cwd) };
    let mut paths = paths.clone();
    if let Some(root) = text(p, "grantRoot") {
        push_new(&mut paths, root);
    }
    ask_tool(if *deletes { "delete" } else { "edit" }, "", None, Some(paths), cwd)
}

/// The ask's `tool` for an ACP permission request (`session/request_permission`): the tool call's own `kind`, one of
/// ACP's (`execute`, `read`, `edit`, `delete`, `search`, `move`, `fetch` …), and from the call's input (`rawInput`) an
/// `execute`'s command line and folder, and the file a file tool names. A search is not known to name its folder and a
/// move its destination, so neither carries paths. A call with no `kind`, or another one, is `other`; the call's
/// title is the agent's words for the person and is never read for it.
pub(crate) fn acp_tool(tc: &Value, session: &str) -> Value {
    let raw = tc.get("rawInput").unwrap_or(&Value::Null);
    let file = || ["filePath", "file_path", "path", "filepath"].into_iter().find_map(|k| text(raw, k)).map(|p| vec![p.to_string()]);
    match tc.get("kind").and_then(Value::as_str).unwrap_or("") {
        "execute" => ask_tool("command", "", text(raw, "command"), None, &run_folder(raw, session)),
        "read" => ask_tool("read", "", None, file(), session),
        "edit" => ask_tool("edit", "", None, file(), session),
        "delete" => ask_tool("delete", "", None, file(), session),
        "search" => ask_tool("read", "", None, None, session),
        "move" => ask_tool("edit", "", None, None, session),
        "fetch" => ask_tool("fetch", "", None, None, session),
        _ => ask_tool("other", "", None, None, session),
    }
}

/// The ask's `tool` for an oh-my-pi tool approval: the tool its dialog names (`Allow tool: bash`) and the arguments
/// of that tool's one running call, which pi announced (`tool_execution_start`) before the dialog. The dialog names no
/// call, so when no call of that tool is running, or several are, `args` is `None` and the arguments are left out.
/// pi's own edit that names its file inside its patch (`input`) carries no path.
pub(crate) fn pi_tool(name: &str, args: Option<&Value>, session: &str) -> Value {
    let a = args.unwrap_or(&Value::Null);
    let file = || text(a, "path").map(|p| vec![p.to_string()]);
    match name {
        "bash" => ask_tool("command", name, text(a, "command"), None, &run_folder(a, session)),
        "write" => ask_tool("write", name, None, file(), session),
        "edit" => ask_tool("edit", name, None, file(), session),
        "read" => ask_tool("read", name, None, file(), session),
        "grep" | "find" | "ls" => ask_tool("read", name, None, None, session),
        _ => ask_tool("other", name, None, None, session),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_part_that_cannot_be_read_whole_is_left_out() {
        assert_eq!(ask_tool("command", "Bash", Some("pnpm test"), None, "/w/proj"), json!({"kind": "command", "name": "Bash", "line": "pnpm test", "cwd": "/w/proj"}));
        // a line over the limit is not cut: it is left out, and the dial asks
        let long = "echo ".to_string() + &"a".repeat(LINE_CHARS);
        assert_eq!(ask_tool("command", "Bash", Some(&long), None, "/w/proj").get("line"), None);
        assert_eq!(ask_tool("command", "", Some("  "), None, "").get("line"), None);
        // a list with a blank, a too long or one too many path is not sent in part
        assert_eq!(ask_tool("edit", "", None, Some(vec!["a.ts".into(), " ".into()]), "/w").get("paths"), None);
        assert_eq!(ask_tool("edit", "", None, Some(vec!["a".repeat(PATH_CHARS + 1)]), "/w").get("paths"), None);
        assert_eq!(ask_tool("edit", "", None, Some((0..=MAX_PATHS).map(|i| format!("f{i}.ts")).collect()), "/w").get("paths"), None);
        assert_eq!(ask_tool("edit", "", None, Some(vec![]), "/w").get("paths"), None);
        assert_eq!(ask_tool("other", "", None, None, ""), json!({"kind": "other"}));
    }

    #[test]
    fn a_command_keeps_its_whole_line_with_its_line_breaks() {
        let t = claude_tool("Bash", &json!({"command": "pnpm test\ngit push origin main", "description": "Test, then push"}), "", "/w/proj");
        assert_eq!(t, json!({"kind": "command", "name": "Bash", "line": "pnpm test\ngit push origin main", "cwd": "/w/proj"}));
        // two spaces inside quotes are two spaces
        assert_eq!(claude_tool("Bash", &json!({"command": "echo 'a  b'"}), "", "/w").get("line"), Some(&json!("echo 'a  b'")));
    }

    #[test]
    fn claude_codes_tools_name_their_kind_and_paths() {
        let cases = [
            ("Edit", json!({"file_path": "/w/proj/src/a.ts", "old_string": "a", "new_string": "b"}), json!({"kind": "edit", "name": "Edit", "paths": ["/w/proj/src/a.ts"], "cwd": "/w/proj"})),
            ("MultiEdit", json!({"file_path": "/w/proj/a.ts", "edits": []}), json!({"kind": "edit", "name": "MultiEdit", "paths": ["/w/proj/a.ts"], "cwd": "/w/proj"})),
            ("NotebookEdit", json!({"notebook_path": "/w/proj/n.ipynb"}), json!({"kind": "edit", "name": "NotebookEdit", "paths": ["/w/proj/n.ipynb"], "cwd": "/w/proj"})),
            ("Write", json!({"file_path": "/w/proj/notes.txt", "content": "hi"}), json!({"kind": "write", "name": "Write", "paths": ["/w/proj/notes.txt"], "cwd": "/w/proj"})),
            ("Read", json!({"file_path": "/w/elsewhere/plan.txt", "limit": 1}), json!({"kind": "read", "name": "Read", "paths": ["/w/elsewhere/plan.txt"], "cwd": "/w/proj"})),
            ("LS", json!({"path": "/w/other"}), json!({"kind": "read", "name": "LS", "paths": ["/w/other"], "cwd": "/w/proj"})),
            ("Grep", json!({"pattern": "TODO", "path": "src"}), json!({"kind": "read", "name": "Grep", "paths": ["src"], "cwd": "/w/proj"})),
            ("Glob", json!({"pattern": "**/*.ts", "path": "/w/proj/src"}), json!({"kind": "read", "name": "Glob", "paths": ["/w/proj/src"], "cwd": "/w/proj"})),
            ("WebFetch", json!({"url": "https://example.com", "prompt": "read it"}), json!({"kind": "fetch", "name": "WebFetch", "cwd": "/w/proj"})),
            ("WebSearch", json!({"query": "qr"}), json!({"kind": "other", "name": "WebSearch", "cwd": "/w/proj"})),
            ("mcp__shop__orders", json!({"status": "open"}), json!({"kind": "other", "name": "mcp__shop__orders", "cwd": "/w/proj"})),
        ];
        for (name, input, want) in cases {
            assert_eq!(claude_tool(name, &input, "", "/w/proj"), want, "{name}");
        }
    }

    #[test]
    fn a_search_that_names_no_folder_or_reaches_past_it_carries_no_path() {
        for input in [json!({"pattern": "TODO"}), json!({"pattern": "**/*.ts"}), json!({"pattern": "/etc/**", "path": "/w/proj"}), json!({"pattern": "../../**/*.env", "path": "/w/proj"}), json!({"pattern": "~/x/*", "path": "/w/proj"}), json!({"pattern": "C:\\x\\*", "path": "/w/proj"})] {
            let name = if input.get("pattern") == Some(&json!("TODO")) { "Grep" } else { "Glob" };
            assert_eq!(claude_tool(name, &input, "", "/w/proj").get("paths"), None, "{input}");
        }
        // a file tool that names no path carries none
        assert_eq!(claude_tool("Edit", &json!({"old_string": "a"}), "", "/w/proj").get("paths"), None);
        assert_eq!(claude_tool("Bash", &json!({"command": ["ls"]}), "", "/w/proj").get("line"), None);
    }

    #[test]
    fn a_command_asking_to_leave_claude_codes_sandbox_is_left_to_the_person() {
        let input = json!({"command": "pnpm test", "dangerouslyDisableSandbox": true});
        assert_eq!(claude_tool("Bash", &input, "", "/w/proj"), json!({"kind": "other", "name": "Bash", "cwd": "/w/proj"}));
        let input = json!({"command": "pnpm test", "dangerouslyDisableSandbox": false});
        assert_eq!(claude_tool("Bash", &input, "", "/w/proj")["kind"], "command");
    }

    #[test]
    fn the_path_claude_code_found_outside_is_named_too() {
        let t = claude_tool("Bash", &json!({"command": "echo gamma > c.txt"}), "/w/proj/c.txt", "/w/proj");
        assert_eq!(t["paths"], json!(["/w/proj/c.txt"]));
        let t = claude_tool("Read", &json!({"file_path": "/w/x/a.txt"}), "/w/x/a.txt", "/w/proj");
        assert_eq!(t["paths"], json!(["/w/x/a.txt"]));
        let t = claude_tool("Edit", &json!({"file_path": "/w/proj/a.ts"}), "/w/x", "/w/proj");
        assert_eq!(t["paths"], json!(["/w/proj/a.ts", "/w/x"]));
    }

    #[test]
    fn a_shell_wrapper_gives_its_script_only_when_it_is_read_exactly() {
        assert_eq!(codex_line("/bin/zsh -lc 'mkdir -p d1'").as_deref(), Some("mkdir -p d1"));
        assert_eq!(codex_line("/bin/zsh -lc 'sleep 30; echo finished'").as_deref(), Some("sleep 30; echo finished"));
        assert_eq!(codex_line("/bin/zsh -lc pwd").as_deref(), Some("pwd"));
        assert_eq!(codex_line(r#"bash -c "pnpm test && echo \"ok\"""#).as_deref(), Some(r#"pnpm test && echo "ok""#));
        // a quote inside a single-quoted script, as a shell writes it
        assert_eq!(codex_line(r"bash -lc 'echo '\''hi'\'''").as_deref(), Some("echo 'hi'"));
        // a line break inside the quotes is the script's own
        assert_eq!(codex_line("/bin/zsh -lc 'pnpm test\ngit push origin main'").as_deref(), Some("pnpm test\ngit push origin main"));
        // no wrapper: the command as Codex sent it
        assert_eq!(codex_line("ls -la | head").as_deref(), Some("ls -la | head"));
        // a wrapper whose script cannot be known for sure
        for raw in ["bash -c 'echo $0' x", "zsh -lc \"echo $HOME\"", "bash -lc 'unclosed", "sh script.sh", "bash -lc ''", "bash -lc 'a' ; rm -rf /", "bash -x -c 'ls'", ""] {
            assert_eq!(codex_line(raw), None, "{raw}");
        }
    }

    #[test]
    fn codex_names_its_command_and_folder() {
        let p = json!({"kind": "command", "command": "/bin/zsh -lc 'mkdir -p d1'", "cwd": "/w/proj/sub"});
        assert_eq!(codex_command_tool(&p, "/w/proj"), json!({"kind": "command", "line": "mkdir -p d1", "cwd": "/w/proj/sub"}));
        // an older request with no kind is a command too; with no folder, the session's
        assert_eq!(codex_command_tool(&json!({"command": "pnpm test"}), "/w/proj"), json!({"kind": "command", "line": "pnpm test", "cwd": "/w/proj"}));
        // a wrapper that is not read exactly carries no line
        assert_eq!(codex_command_tool(&json!({"command": "bash -c 'echo $0' x"}), "/w/proj"), json!({"kind": "command", "cwd": "/w/proj"}));
        // another kind of request is not a command
        assert_eq!(codex_command_tool(&json!({"kind": "network", "command": "curl x"}), "/w/proj"), json!({"kind": "other", "cwd": "/w/proj"}));
    }

    #[test]
    fn a_codex_file_change_names_every_path_and_whether_it_deletes() {
        let item = json!({"changes": [
            {"path": "/w/proj/a.ts", "kind": {"type": "update", "move_path": null}},
            {"path": "/w/proj/b.ts", "kind": {"type": "add"}},
        ]});
        assert_eq!(codex_change(&item), Some((vec!["/w/proj/a.ts".into(), "/w/proj/b.ts".into()], false)));
        // a move names where the file goes too, and a delete says so
        let item = json!({"changes": [{"path": "/w/proj/a.ts", "kind": {"type": "update", "move_path": "/w/elsewhere/a.ts"}}, {"path": "/w/proj/old.ts", "kind": {"type": "delete"}}]});
        assert_eq!(codex_change(&item), Some((vec!["/w/proj/a.ts".into(), "/w/elsewhere/a.ts".into(), "/w/proj/old.ts".into()], true)));
        // a change it cannot read whole makes the whole list unknown
        for item in [json!({"changes": [{"path": "/w/proj/a.ts", "kind": {"type": "rename"}}]}), json!({"changes": [{"kind": {"type": "add"}}]}), json!({"changes": []}), json!({})] {
            assert_eq!(codex_change(&item), None, "{item}");
        }
        let change = codex_change(&json!({"changes": [{"path": "/w/proj/a.ts", "kind": "delete"}]}));
        assert_eq!(codex_change_tool(change.as_ref(), &json!({"grantRoot": null}), "/w/proj"), json!({"kind": "delete", "paths": ["/w/proj/a.ts"], "cwd": "/w/proj"}));
        // the folder Codex asks to keep writing under is named with the files
        let change = codex_change(&json!({"changes": [{"path": "/w/proj/a.ts", "kind": {"type": "add"}}]}));
        assert_eq!(codex_change_tool(change.as_ref(), &json!({"grantRoot": "/"}), "/w/proj")["paths"], json!(["/w/proj/a.ts", "/"]));
        // an item never seen names no path
        assert_eq!(codex_change_tool(None, &json!({}), "/w/proj"), json!({"kind": "edit", "cwd": "/w/proj"}));
    }

    #[test]
    fn an_acp_call_is_read_by_its_own_kind_never_its_title() {
        let call = |kind: Value, raw: Value| json!({"toolCallId": "c", "title": "bash", "kind": kind, "rawInput": raw});
        assert_eq!(acp_tool(&call(json!("execute"), json!({"command": "echo hi > a.txt"})), "/w/proj"), json!({"kind": "command", "line": "echo hi > a.txt", "cwd": "/w/proj"}));
        // a folder the call names is where it runs, read from the session's folder
        assert_eq!(acp_tool(&call(json!("execute"), json!({"command": "ls", "workdir": "sub"})), "/w/proj")["cwd"], json!("/w/proj/sub"));
        assert_eq!(acp_tool(&call(json!("execute"), json!({"command": "ls", "directory": "/w/other"})), "/w/proj")["cwd"], json!("/w/other"));
        assert_eq!(acp_tool(&call(json!("edit"), json!({"filePath": "/w/proj/a.ts", "oldString": "a"})), "/w/proj"), json!({"kind": "edit", "paths": ["/w/proj/a.ts"], "cwd": "/w/proj"}));
        assert_eq!(acp_tool(&call(json!("read"), json!({"filepath": "/w/x.txt"})), "/w/proj")["paths"], json!(["/w/x.txt"]));
        assert_eq!(acp_tool(&call(json!("delete"), json!({"path": "old.ts"})), "/w/proj"), json!({"kind": "delete", "paths": ["old.ts"], "cwd": "/w/proj"}));
        assert_eq!(acp_tool(&call(json!("search"), json!({"pattern": "x", "path": "/w"})), "/w/proj"), json!({"kind": "read", "cwd": "/w/proj"}));
        assert_eq!(acp_tool(&call(json!("move"), json!({"path": "a.ts"})), "/w/proj"), json!({"kind": "edit", "cwd": "/w/proj"}));
        assert_eq!(acp_tool(&call(json!("fetch"), json!({"url": "https://x"})), "/w/proj"), json!({"kind": "fetch", "cwd": "/w/proj"}));
        // no kind, or one ACP does not define: the title "bash" is not read
        for kind in [Value::Null, json!("think"), json!("terminal")] {
            assert_eq!(acp_tool(&call(kind.clone(), json!({"command": "ls"})), "/w/proj"), json!({"kind": "other", "cwd": "/w/proj"}), "{kind}");
        }
    }

    #[test]
    fn a_pi_approval_names_its_running_calls_arguments() {
        assert_eq!(pi_tool("bash", Some(&json!({"command": "ls -la"})), "/w/proj"), json!({"kind": "command", "name": "bash", "line": "ls -la", "cwd": "/w/proj"}));
        assert_eq!(pi_tool("write", Some(&json!({"path": "notes.txt", "content": "hi"})), "/w/proj"), json!({"kind": "write", "name": "write", "paths": ["notes.txt"], "cwd": "/w/proj"}));
        // oh-my-pi's edit names its file inside its patch: no path
        assert_eq!(pi_tool("edit", Some(&json!({"edits": [], "input": "README.md"})), "/w/proj"), json!({"kind": "edit", "name": "edit", "cwd": "/w/proj"}));
        // no running call of that tool, or several: nothing but the tool
        assert_eq!(pi_tool("bash", None, "/w/proj"), json!({"kind": "command", "name": "bash", "cwd": "/w/proj"}));
        assert_eq!(pi_tool("grep", Some(&json!({"pattern": "x", "path": "/w"})), "/w/proj"), json!({"kind": "read", "name": "grep", "cwd": "/w/proj"}));
        assert_eq!(pi_tool("task", Some(&json!({})), "/w/proj"), json!({"kind": "other", "name": "task", "cwd": "/w/proj"}));
    }
}
