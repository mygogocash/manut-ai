# Paradev's features for the code mode, and what Manut AI has of them (28 Nov 2026)

On 27 Nov the owner set the goal of every feature not done yet, macOS first and then iOS, and pointed at Paradev as a
resource "to maximize for code mode" (`docs/decisions/2026-11-27-macos-then-ios.md`). This is item 138's study. Paradev
(`paradevai/paradev`) is an open-source workspace for running many coding agents side by side, each in its own git
worktree, on the person's own plans and keys: an Electron desktop app for macOS (Linux experimental, no Windows), phone
apps for iOS and Android, a web app, a relay, and a cloud with paid plans. It was called Superset until it was renamed,
so its command is still `superset` and its packages are `@superset/`.

Paradev is MIT licensed (Copyright (c) 2025-2026 Superset Inc.), so its code may be lifted with a credit in `CREDITS.md`,
as T3 Code's and Orca's were. The study read `main` at `2db3bbaf37ffbe24b78c8cdb974bf34632e6fb20` (27 Nov 2026), cloned
read-only and never installed, built or run: the README, the docs (`apps/docs/content/docs/`), `apps/desktop`,
`apps/mobile`, `apps/relay`, `apps/review-host`, and the packages that bear on the code mode (`panes`, `port-scanner`,
`pty-daemon`, `workspace-fs`, `workspace-client`, `macos-process-metrics`, `agent-setup`, `agent-harness`, `chat`,
`chat-ui`, `chat-runtime`, `mcp`, `host-service`, `sandbox`, and parts of `shared`). Each row was checked against Manut
AI's code and `docs/plan.md` on 28 Nov, by grep, not from memory. Of 117 Paradev features that bear on the code mode,
Manut AI has 37, has 2 built and switched off, has part of 27, and has none of 51. The plan's rows for the rest are items
145 to 166; where items 94 to 137 or 108 already plan a feature, the Plan column points at them. Paradev's marketing,
billing, its plugins for Slack, Gmail and the rest, its leaderboard and its settings sync are left out: none bears on
the code mode.

Words used: **has** (works today), **part** (some of it), **off** (built, switched off), **no** (nothing built). "Asks
first" means the one ask path (`packages/approval-core`). A path named as Paradev's is in its repository at that commit.

## Where the two apps differ on purpose

Paradev is for a developer who lets many agents run unwatched and reviews their branches afterwards. Manut AI's one
promise is that anything public, costly or irreversible asks the person first, through approval-core, and settles once.
No row below adds a way round it. Six differences follow, and the plan keeps them:

- **Agents start in a mode that asks.** Paradev starts Claude Code with `--dangerously-skip-permissions` and Codex with
  `--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust` by default
  (`apps/docs/content/docs/agents/claude-code.mdx`, `agents/codex.mdx`); a fork passes the same flags, and an agent
  imported as a terminal script gets them too. Manut AI never starts an agent in a mode that skips its asks: Settings ›
  Providers refuses those flags as launch arguments (`apps/desktop/src/settings/providers/argRules.json`), each ask is a
  card read by Kit's dial and settled once, and no lift brings a launch command with it.
- **Nothing is written into the person's own agent settings.** Paradev merges its status hooks into
  `~/.claude/settings.json` and `~/.codex/hooks.json`, and writes its skills into `~/.claude/skills/` and `~/.agents/`,
  at each launch (`packages/agent-setup/src/agent-wrappers-claude-codex-opencode.ts`, `apps/docs/content/docs/skills.mdx`).
  Manut AI copies a project's agent settings into a lane (item 72) and passes anything of its own for one session only,
  as `--settings` already carries the status line relay to a terminal Claude Code (`apps/desktop/src-tauri/src/claude_usage.rs`).
- **A project's own files run nothing by themselves.** Paradev runs a repository's `.paradev/config.json` setup commands
  when a workspace is made, and its examples copy the developer's `.env` in. In Manut AI a lane starts with the committed
  tree only and nothing installed, and its agent installs through the dial (`docs/code-editor.md`, "What a project's own
  files cannot do"). Row 145 brings setup commands in through an ask.
- **What leaves the Mac is masked, and the phone's channel is end to end.** Paradev's "Continue with another agent" sends
  the last 36,000 characters of a terminal with nothing redacted (`apps/docs/content/docs/agent-sessions.mdx`). Its relay
  is a Cloudflare tunnel that carries the host's own requests and can read them, letting in whoever the account's sign-in
  and the host's member list allow (`apps/relay/src/host-tunnel.ts`, `apps/relay/src/access.ts`). Its phone's approval
  card shows at most 600 characters of what will run (`DETAIL_CHARS` in `apps/mobile/screens/(authenticated)/workspace/[id]/components/ChatRowView/components/ApprovalCard/ApprovalCard.tsx`).
  Manut AI masks and caps context before it goes (item 97), pairs a phone to a Mac with a code and a passkey over an
  end-to-end channel (`packages/remote-channel`), and shows the whole command for each Allow, with Face ID.
- **The preview shows only the lane's own page.** Paradev's browser pane goes anywhere, runs Chrome extensions, imports
  Chrome's cookies, and lets agents drive it over the Chrome DevTools Protocol. Manut AI's frame shows only an address of
  this computer that the lane's own preview runs at, sandboxed, with no way into the app (`docs/code-editor.md`, "The page
  in the pane"). WebKit has no DevTools protocol and runs no Chrome extensions.
- **Nothing spends money or opens the Mac without the owner.** Paradev puts remote access, its phone apps and its
  automations behind a paid plan and sells a cloud machine for each workspace. Manut AI builds other machines switched off
  (item 108) and plans no cloud machine.

Manut AI also has things this study found nothing like in Paradev: each lane's test runs read and named, and Kit's dial
reading every command an agent asks to run. Paradev's chat, like Rewind here, keeps each turn's changed files and can
undo them (`packages/chat-runtime/src/checkpoints/`).

## The basics

| Feature | Today | Plan |
| --- | --- | --- |
| Open source, on the person's own agents and plans | has: MIT (`LICENSE`, item 111a); each agent runs on the person's own sign-in, and no model call goes through us | |
| A macOS desktop app | has (0.1.1, Apple silicon and Intel, unsigned until the Apple secrets) | |
| Linux | part: an AppImage and a .deb in the release's draft (item 111b), not yet run on GitHub; Paradev's AppImage is experimental too | 111b |
| Phone apps for iOS and Android | part: the installed web app `/app/` with its Your Mac tab (items 17, 78c) | 111e, 166 |
| A web app on the person's workspaces | part: `/app/`'s Your Mac shows a paired Mac's chats and asks; Your machines is item 108d | 108d |

## Workspaces and lanes

| Feature | Today | Plan |
| --- | --- | --- |
| A worktree and a branch for each task, several at once | has (lanes under `~/.manut/lanes`, `apps/desktop/src-tauri/src/lane.rs`) | |
| Where worktrees go, and the branch prefix | has (Settings › Worktrees, item 73) | |
| A new workspace from a new branch, an existing branch or a pull request | part: a lane starts from the developer's branch, or from the remote's latest of it (Start from the remote); never from another branch or a request | 147 |
| Restore a deleted workspace on its branch | no: a removed lane's branch stays, but nothing makes a lane from it again | 147 |
| The branch and title named from the prompt by a model, the branch renamed while unpushed | part: the branch is named from the first message's words with no model and is never renamed; a chat's title by Claude Code (item 96, off by default) | not planned |
| Reuse an earlier prompt from a history | part: Up and Down recall a chat's earlier prompts, and Drafts keep five (item 95); no history across chats | |
| A session with no project, in a scratch folder with git | part: New project makes a folder in the home folder with git (item 100b); a coding chat always has a folder | |
| Pin, and drag to reorder | has | |
| A board of workspaces by state (Idle, Working, Needs attention, Needs review, Merged, Deleted) | part: the Lanes band lists each lane with its state; Recent and History have their sections (item 94); no board | 162 |
| Ahead and behind counts on a row | no: only Remove's panel counts a branch's commits that are not on its base | 146 |
| A pull request's state on a row | has (items 76 and 100) | |
| Select several to delete or group | part: several rows at once to pin, snooze, settle or archive (item 94); a lane's folder goes one at a time, with its counts | |
| Setup and teardown commands from the repository, with a person's own overrides | no: a project's own files run nothing by themselves, so a lane starts with nothing installed | 145 |
| A Run button: the project's own dev server command, restartable, in its own pane | part: the lane's preview runs `dev`, `start`, `preview` or `serve` from `package.json` (`@manut/preview-command`), with Start and Stop; a project cannot name its own command | 145 |
| Each workspace's paths and name as variables in its terminals | no | 145 |
| Sparse checkout for a large repository | no: a lane checks out the whole committed tree | 164 |
| A session started in a monorepo's subfolder | has: it works in the same subfolder of its worktree | |
| Bring existing worktrees in | part: a worktree can be added as a folder, a terminal works in it, and a chat there starts a lane of its own from it; it is never adopted as a lane, since only folders the app made are ever removed | not planned |

## Terminals

| Feature | Today | Plan |
| --- | --- | --- |
| Tabs and splits | has: the bottom panel's tabs of up to four panes (`apps/desktop/src/terminal/layout.ts`), and sessions side by side | |
| Terminals and their agents live through quitting and updating the app | part: closing the window keeps them running from the menu bar (When the window closes, Keep running); quitting or an update ends them, and each terminal's text comes back dimmed after a restart (`apps/desktop/src-tauri/src/term_history.rs`) | 153 |
| An agent whose terminal died is resumed by itself | part: Resume and Restart, each a press, start it again in its own folder (`resume_args` in `apps/desktop/src-tauri/src/sessions.rs`: Claude Code, OmO, DeepSeek Harness) | not planned |
| Fork a session with the agent's own fork | no | 157 |
| Continue with another agent, with the session's context | has (item 97): masked, capped at 6,000 characters and shown before it goes | |
| Find, clear and scroll to the bottom | has (`apps/desktop/src/sessions/term/engine-find.ts`) | |
| A warning before closing a running terminal | has, another way: a closed terminal keeps its program running for a while, so the close can be undone | |
| Cmd+click on a web address | has (`apps/desktop/src/sessions/term/engine-links.ts`) | |
| Cmd+click on a file path with its line and column | no | 148 |
| Copying that trims trailing spaces and joins wrapped lines | no | 148 |
| The keyboard and mouse given back when an agent dies uncleanly | no: after a TUI is killed mid-run, keys arrive encoded until `reset` | 148 |
| Terminal scripts: saved commands in a bar, Control+1 to Control+9 | no | 160 |
| Mark a terminal unread | no | not planned: Snooze and Done for now do it (item 94) |

## Agents and status

| Feature | Today | Plan |
| --- | --- | --- |
| Many agents built in, and any CLI agent added | has: Claude Code, Codex, OpenCode, Gemini CLI, Grok, pi, oh-my-pi, Cursor, Antigravity, the ACP registry's and a person's own (Settings › Providers) | |
| An agent shown as a chat, its asks answered with a click | has: Chat with Kit, every ask a card through approval-core | |
| Messages written while the agent works wait their turn | has (item 95): a coding chat holds a message until the answer is done, and a key adds it at once instead | |
| An agent asks before it reads files outside its workspace | has: such a read is stopped and shown, with Allow this folder (Kit's dial, `apps/desktop/src/code/kitAsks.ts`) | |
| Rewind a chat to an earlier message, and undo a turn's file changes | has: Rewind puts back a kept turn's files and its chat, and Bring it back undoes the rewind (Claude Code and Codex; `apps/desktop/src/sessions/rewind.ts`, `apps/desktop/src-tauri/src/turn_files.rs`) | |
| Find in a chat (Command+F) | no: Find is the terminal's only | 150 |
| Switch a running session between chat and terminal, keeping its context | part: a Claude Code chat's Terminal view continues the same conversation (`--resume`), and back; other agents start fresh in the terminal | |
| Working, needs you and done on each row | part: has for a lane, from its chat's events; for an agent in a terminal, working and done from the program's own OSC 9;4, never needs you (`apps/desktop/src/sessions/term/engine-marks.ts`) | 152 |
| A chime when an agent finishes | has (item 131) | |
| A Dock badge | has (item 6) | |
| Notifications when an agent finishes or waits | has (item 6, `@manut/notify-rules`) | |
| Subagents under their parent | has | |
| Model and effort pickers | has (item 132) | |
| Several accounts for one agent, and which is the default | has: Claude Code, Codex, Grok and pi (item 101d) | |
| Quota meters for each account | part: Claude Code and Codex, from what each CLI reports as it runs or keeps in its own session files (`apps/desktop/src/sidebar/usageFormat.ts`, `apps/desktop/src-tauri/src/claude_usage.rs`); Paradev calls each provider's usage address with the stored credentials, which Manut AI never reads | |
| Token costs at API prices from the agents' logs | part: tokens of sessions run outside Manut AI, today and this week (items 106, 106b); no prices | not planned |
| CPU and memory for each workspace and terminal | no: the Mac's memory is read only for the helper cap (`machine_memory`, item 102h) | 154 |
| Each agent's minimum version, with the line that upgrades it | part: Settings › Providers shows each agent's version; no minimums | |
| A provider for Claude Code through environment variables (Bedrock, Vertex, OpenRouter) | has: Settings › Providers' environment variables for each agent, never sent back to the page | |
| An agent's command or a chat kept as a draft until the person sends | has: nothing runs until the first message | |
| A prompt template for tasks, for each agent | no | 161 |

## Review and pull requests

| Feature | Today | Plan |
| --- | --- | --- |
| A changes pane: against the base, commits, staged and unstaged | part: the pane's Diff shows everything since the lane started, committed or not, new files included (item 71); no sections | 146 |
| Split and unified layouts | part: unified only (`DiffView`) | 146 |
| One file at a time, with Prev and Next | no | 146 |
| Select diff lines and send them to an agent with the file and the lines | part: a note on text selected in the pane goes as a quote (item 97), without its file or lines | 146 |
| Open the file at a diff line | part: Open in an editor opens the lane's folder (item 107), not a file at a line | 149 |
| Stage, commit, push and pull from buttons | part: Put up for review pushes and opens the request through one ask (item 75), and Automatically pull keeps a clean default branch current; commits are the agent's, through the dial | not planned |
| Every request of the projects, with filters and a checks summary | has (Tasks › Pull requests, by readiness, item 100) | |
| A request's description and checks | has (item 100) | |
| A request's whole diff | part: its files and their counts only | 151 |
| Review threads and comments: read, reply, resolve | no | 151, 158 |
| Fix checks with an agent, Address comments with an agent | no | 151 |
| Comment on a request's lines straight to an agent, making a workspace when it has none | no | 151, 147 |
| Start a workspace from a request | no | 147 |
| Merge with a method | has (item 75: one ask with its method and exact message) | |
| Stacked requests, Merge stack and Restack | no | 159 |
| A merge queue | no | 159 |
| Close and reopen a request | no | 158 |

## Files and the editor

| Feature | Today | Plan |
| --- | --- | --- |
| A file tree with git's marks | no | 149 |
| Quick open (Command+P) | no | 149 |
| Search in files | no | 149 |
| An image viewer | no | 149 |
| A file's Markdown drawn | no: answers draw Markdown, files are not shown | 149 |
| A built-in editor: save, a banner when the file changed underneath, compare, auto save | no: the person's own editor opens the lane (item 107) | 165 |
| Create, rename, move and delete files from the tree | no | 165 |
| Open in the person's editor | has (item 107: VS Code, Cursor, Windsurf, Zed, Xcode) | |

## The browser and ports

| Feature | Today | Plan |
| --- | --- | --- |
| A browser beside the terminals for the dev server | has: the lane's preview page in the pane, at an address of this computer, sandboxed | |
| An address bar, history, back and forward | no, on purpose: the frame shows only the lane's own preview | not planned |
| DevTools for the page | no | not planned |
| Design mode: click an element and tell an agent what to change | no | 156 |
| Chrome extensions, passkeys and Chrome's cookies in the pane | no: WebKit runs no Chrome extensions, and the frame keeps no sign-in | not planned |
| Agents drive the pane (open, read, screenshot, console, the DevTools protocol) | no: WebKit has no DevTools protocol; agents have computer use (item 82) and the outposts | not planned |
| Each workspace's listening ports, and Stop | has: What keeps running lists each command and preview with its ports and Stop, for the project (`apps/desktop/src-tauri/src/running.rs`, read with libproc) | |
| A port opened in the pane, and the terminal that owns it | no | 155 |
| Port labels from a file in the project | no | 155 |

## Orchestration, automation and tasks

| Feature | Today | Plan |
| --- | --- | --- |
| One agent runs workers in separate workspaces | has: helper lanes a lane asks for, each round on a card, their landings one at a time (item 102) | |
| The same prompt to several agents at once | has (item 102a) | |
| Runs on a schedule | off: workflows, in Labs, off by default (item 77b) | |
| Runs on an event: a review request, Slack, Linear, Sentry, a webhook | no | 109 (a webhook); the rest not planned |
| An MCP server for workspaces, agents, terminals, tasks and hosts | part: item 103's door lists, reads, messages and opens lanes, each on a card; no terminals, tasks or hosts | 103 |
| A CLI and a TypeScript SDK that drive the app | no | not planned |
| Skills that teach agents to drive the app, kept in each agent's config | no, on purpose | not planned |
| Issues from GitHub and Linear, a workspace for each | part: Start in thread from an issue or request, masked (`apps/desktop/src/tasks/message.ts`), one at a time; GitHub and GitLab | 161 |
| Pages: an agent publishes HTML for a team to comment on | no | not planned |
| Agents drive native apps | has: computer use (item 82), never run against a real window | |

## Other machines and the phone

| Feature | Today | Plan |
| --- | --- | --- |
| Reach a workspace on another machine through a relay | part: the phone's link through the relay is built and off (item 78); a desktop reaching another machine is item 108 | 108 |
| A host left running on a server, or on a Mac with no window | no | 108a |
| Set up a host over SSH | no | not planned: item 108's roads are the relay, Tailscale and the local network |
| Teammates given access to a host | no | 108b |
| A remote workspace's ports forwarded to this computer | no | 108g (the preview as pictures) |
| Move a workspace to another machine | no | 108i |
| A cloud machine for each workspace | no: it costs money | not planned |
| From the phone: start an agent in a new workspace | no | 108c, 108d |
| From the phone: follow a session and answer its asks | off: Your Mac (item 78c), on in dev only; the whole command, and Face ID for each Allow | 78 |
| From the phone: review the diff with line comments and send the review to an agent | no (item 78 left diffs out on purpose) | 166 |
| From the phone: merge a request, fix its checks with an agent | no | 166 |
| Live Activities | no: only a native app has them | 111e, 166 |

## Look and use

| Feature | Today | Plan |
| --- | --- | --- |
| Several windows | no | 163 |
| Keybindings a person sets | has (item 99a) | |
| Themes, imported | has: themes of the person's own and imported VS Code themes (item 99b); no marketplace | |
| A command palette | has | |

## What can be lifted, row by row

Paradev's desktop is Electron with Node in its main process, and most of its code-mode logic lives in
`packages/host-service`, a Node server (Hono, tRPC, drizzle on SQLite, `node-pty`, `simple-git`). None of that runs in
Manut AI's Rust shell or its page. What lifts are the pure TypeScript pieces that need only what Manut AI already has
(React, `@xterm/xterm`), and logic small enough to port to Rust. Paradev's tests run on `bun:test`; a lifted file's
tests are ported to vitest beside it. No lift below needs a new dependency except row 165's editor.

| Row | From Paradev | What it does | How |
| --- | --- | --- | --- |
| 145 | `packages/host-service/src/runtime/setup/config.ts` (446 lines) and `apps/docs/content/docs/setup-teardown-scripts.mdx` | Where setup, teardown and run come from: the repository's `.paradev/config.json`, a person's override under `~/.paradev/projects/`, a `config.local.json` with `before` and `after`, and a `.paradev/setup.sh` when no command is named | Read for behaviour; written anew around the ask, since Paradev's runs the commands by itself |
| 146 | none | Paradev draws diffs with `@pierre/diffs` | Not lifted, as it is a new dependency; the split view, one file at a time and the sections are drawn by Manut AI's own `DiffView` |
| 147 | `packages/host-service/src/trpc/router/workspace-creation/` | A workspace from an existing branch or a pull request | Read; `lane.rs` makes the lane with the app's own git rules (items 114, 118) |
| 148 | `packages/shared/src/leaked-input-mode-reclaim.ts` (156 lines) and `apps/desktop/src/renderer/lib/terminal/terminalInputModeReclaimer.ts` (110) | Decides which input modes a killed TUI left on (the kitty keyboard protocol, mouse and focus reporting) and writes the sequences that turn them off once the shell has the terminal again | Lift, with `@xterm/xterm` only. Paradev knows the shell is back by a marker its own shell wrappers print (`OSC 777`); Manut AI puts no hook into the shell, so the sign is the end of the agent process the shell started |
| 148 | `packages/shared/src/terminal-link-parsing/` (692 lines) and the file-path parts of `apps/desktop/src/renderer/lib/terminal/links/` (about 1,060) | Finds `path`, `path:line` and `path:line:col` in a terminal's lines, across wrapped lines, and resolves them against the terminal's folder | Lift with its three small helpers (`bareWebUrl`, `fileLocation`, `pathText`); only a path inside the session's folder opens |
| 148 | `apps/desktop/src/renderer/lib/terminal/terminal-copy.ts` (127) and `terminal-clipboard.ts` (17) | Copying by Ghostty's rules: trailing spaces and blank lines dropped, lines wrapped by the width joined | Lift |
| 149 | `packages/workspace-fs/src/fuzzy-scorer.ts` (903 lines, no imports) | VS Code's fuzzy file scorer (MIT, Microsoft), as Paradev ported it | Lift with both notices. The file list and the search are the shell's own (`git ls-files`, `git grep`), where Paradev's `packages/workspace-fs/src/search.ts` runs `rg`, which Manut AI does not have |
| 150 | `apps/desktop/src/renderer/routes/_authenticated/_dashboard/workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/` (`utils/transcriptFind`, 128 lines; `utils/transcriptHighlights`, 162; `hooks/useTranscriptFind`, 351) | Finds text across a chat's rows, folded steps included, and paints each match | Read, and written again over the app's own timeline, since it walks Paradev's chat rows; it paints with the CSS Custom Highlight API, which older WebKit lacks, so it checks for it first as Paradev's does |
| 151 | `apps/desktop/src/renderer/routes/_authenticated/_dashboard/pull-requests/utils/buildPullRequestRepairPrompts/buildPullRequestRepairPrompts.ts` (117) | The message that asks an agent to fix failing checks or to address review comments: at most 12 findings, each field cut at 800 characters | Lift its shape and caps; masked with `apps/desktop/src/lib/secrets.ts` before it fills a box |
| 152 | `packages/agent-setup/src/agent-wrappers-claude-codex-opencode.ts` and `packages/agent-setup/templates/notify-hook.template.sh` | Which lifecycle hooks report an agent's state, and how a hook tells its own session from a nested agent's | Read for the events; Manut AI passes its hooks for one session (`--settings`), never into the person's settings |
| 153 | `packages/pty-daemon/` (Node and `node-pty`) | Terminals owned by a daemon outside the app: a Unix socket with a JSON header and a binary tail for each frame, a version handshake, a successor daemon handed the open terminals on an update, a 64 KiB replay buffer, and `TerminalModes` with its `ControlSequenceScanner` (pure, 317 lines) restoring a screen's modes on reattach | Read for the design; `TerminalModes` may be lifted. Its `trustd-probe.ts` records a lesson: a daemon started outside the login session can lose `com.apple.trustd`, and then `gh` fails every TLS check |
| 154 | `packages/macos-process-metrics/src/addon.cc` (56 lines of C++) and `apps/desktop/src/main/lib/resource-metrics/` | `proc_pid_rusage` for `ri_phys_footprint`, the memory Activity Monitor shows, and CPU and memory grouped by workspace and terminal | Port to Rust in `running.rs`: the `libc` 0.2.191 already in the lock binds `proc_pid_rusage` and `rusage_info_v4`, where Paradev's addon needs Node |
| 155 | `packages/port-scanner/src/static-ports.ts` (no imports) and the hint patterns in `packages/port-scanner/src/port-manager.ts` | Reads and checks a project's `ports.json` labels; scans again soon after a line such as "Local: http://" | Lift both; the scan stays `running.rs`'s libproc read, where Paradev runs `lsof` |
| 156 | `apps/desktop/src/main/lib/browser/design-mode-script.ts` (677), `design-mode-payload.ts` (208) and `apps/desktop/src/shared/browser-design-mode.ts` (188) | The picker: an overlay in a shadow root, hover, and what is taken from the clicked element (tag, text, attributes on a safe list, chosen computed styles, the React component), with its patterns for secrets and its size budget | Lift the script and its limits. Paradev puts it in with Electron's `executeJavaScript` and crops a `capturePage` picture, which Tauri lacks; here it goes in by Tauri's `initialization_script_for_all_frames` (tauri 2.12.7, read in its source) |
| 157 | `apps/docs/content/docs/agent-sessions.mdx` | Each agent's fork command | Read; the flags checked in each CLI's own help on 28 Nov (Claude Code's `--fork-session`, Codex's `fork`) |
| 159 | `packages/shared/src/pull-request-stack/pull-request-stack.ts` (603 lines, no imports, 588 lines of tests) | Infers a stack of requests from their base branches, one verdict for the stack, and each layer's state | Lift with its tests |
| 160 | `apps/docs/content/docs/terminal-scripts.mdx` | The scripts' fields and their launch modes | Read; Paradev's scripts for an agent take the bypass flags by default, which are refused here |
| 162 | `apps/docs/content/docs/workspaces.mdx` | Board columns from agent and request state | Read |
| 163 | `apps/docs/content/docs/multiple-windows.mdx` | What each window owns and what all windows share | Read |
| 164 | `apps/docs/content/docs/using-monorepos.mdx` | Sparse checkout in git's cone mode, falling back to a full checkout | Read |
| 165 | `apps/desktop/package.json` (`@codemirror/*` 6.x, about 20 packages) and `apps/docs/content/docs/editor.mdx` | A file editor, and its rules for a file changed underneath | Needs the owner's yes to CodeMirror 6 |

What does not lift, and why:

| Paradev part | Why not |
| --- | --- |
| `packages/host-service` (about 155,000 lines) | A Node server: Hono, tRPC, drizzle on SQLite, `node-pty`, `simple-git`, `@octokit/rest`, and ACP adapters from npm; Manut AI's shell is Rust with adapters of its own |
| `packages/pty-daemon` | Node and `node-pty` (read for row 153) |
| `packages/workspace-client` | tRPC and `partysocket` over Paradev's relay |
| `packages/panes` | React with `react-dnd`, `zustand` and Lingui, all new; `apps/desktop/src/terminal/layout.ts` already holds a binary layout tree |
| `packages/chat`, `packages/chat-ui`, `packages/chat-runtime` | Lexical, `streamdown`, `@anthropic-ai/claude-agent-sdk` and `better-sqlite3`; Manut AI has its own timeline (`packages/agent-events`) and adapters |
| `packages/agent-harness` | Temporal workflows (`@temporalio/client`) |
| `packages/mcp` | A cloud MCP server (`https://api.superset.sh/mcp`) with `better-auth` and drizzle; Manut AI's door is local and asks (item 103) |
| `packages/sandbox` | Cloud machines on Vercel Sandbox |
| `apps/relay` | A Cloudflare tunnel that can read what passes; Manut AI's relay carries an end-to-end channel |
| The browser pane (`apps/desktop/src/main/lib/browser/`) | Electron's `WebContentsView`, `electron-chrome-extensions` and the DevTools protocol |
| `@pierre/diffs`, `@pierre/trees`, CodeMirror | New dependencies |

## The phone: Paradev's mobile app

**What it is built with.** `apps/mobile` is an Expo app (`expo` 58.0.21, React Native 0.88.1, `expo-router` 58.0.28),
for iPhone, iPad and Android, with iOS 26 as its lowest version (`apps/mobile/app.config.ts`). It uses TanStack Query
with an AsyncStorage persister, tRPC clients, Shiki for diffs, `react-native-webview` for the terminal (xterm.js in a
page, `TerminalWebView`), `react-native-webrtc` for voice, and `better-auth` with Sign in with Apple. Its own native
modules are in `apps/mobile/modules/` (`live-activity`, `composer`, `voice`, `forward-swipe`, `attachments-sheet` and
others), and a widget extension in Swift (`apps/mobile/targets/agentactivity/`) draws its Live Activity. It needs
Paradev's paid plan.

**What it does.** Home lists the workspaces of one machine, grouped by project, each with a dot: yellow when an agent
needs permission, red when a run failed, green when work is ready to review; a machine picker shows which machines are
online. A prompt box makes a workspace on the chosen machine with a project, a base branch, an agent, a model and
effort, and photos or files. In a workspace a person follows each session live as chat rows, answers an agent's asks on
an approval card (the agent's own options, its detail cut at 600 characters) and its questions, opens its terminal,
reads the changed files with highlighted diffs, comments on a line, and finishes a review that goes to an open session
or a new one. A request shows its checks, reviewers and comments, merges by squash, merge commit or rebase, and hands
failing checks or comments to an agent. Pages, voice and the machines' list are there too. The Live Activity is a card
for each terminal with a status word ("Needs you", "Working", "Review") and the time in that state, updated by the app
itself (`pushType: nil` in `apps/mobile/modules/live-activity/ios/LiveActivityModule.swift`), not by a push.
`expo-notifications` is a dependency, but no screen imports it at this commit.

**How it reaches a desktop.** The person signs in with the same Paradev account and organization, and the desktop turns
on Remote Access (which restarts its host service). The phone asks the API which relay the machine is on, then calls the
host's own tRPC through it (`<relay>/hosts/<routing key>/trpc`, `apps/mobile/lib/host-service/client.ts`) with the
account's token. The relay (`apps/relay`, a Cloudflare Worker on Durable Objects, Hono and partyserver) checks the caller
is a member of the host through the API, keeps an allowed answer for 15 minutes (`apps/relay/src/access.ts`), and tunnels
HTTP and WebSocket traffic to the host's own outbound connection (`apps/relay/src/host-tunnel.ts`). Each leg is TLS;
there is no end-to-end layer, so the relay can read what passes. A cloud workspace is reached at an address the cloud
brokers. `apps/review-host` is a set of shell scripts (`setup.sh`, `provision.sh`, `run.sh`, `update.sh`,
`self-update.sh`, `watchdog.sh`, `check.sh`) that keep a machine running for Apple's App Review, so a reviewer has a host
to connect the phone to.

**What Manut AI's iOS work could take from it.**

- Its screen map as the model for Your machines (item 108d) and for a native app: machines with an online mark, lanes by
  project with one mark for what needs the person, a session's chat with its asks, the changed files, a review sent to a
  lane, a request's checks with Merge, and Fix checks or Address comments handed to a lane.
- Its Live Activity (`apps/mobile/targets/agentactivity/AgentActivityWidget.swift`, `AgentActivityAttributes.swift`), for
  a native app only: a card for each lane with a translated status word and its time, carrying no command and no text of
  the chat, as `@manut/notify-rules` hides details.
- Its pure helpers: what needs the person first (`apps/mobile/screens/(authenticated)/(home)/home/utils/needsMe/needsMe.ts`,
  `apps/mobile/screens/(authenticated)/(home)/home/hooks/useHostTerminals/attention.ts`) and the Live Activity's order (`apps/mobile/modules/live-activity/src/orderRows.ts`).
- The terminal as xterm.js in a web view, for a native app; the web app would need `@xterm/xterm` in `apps/web`, the
  owner's yes (`docs/multi-machine.md`, part 6).
- The App Review lesson: an app that needs a desktop needs a way for a reviewer to try it. Manut AI's Practice mode, with
  a pretend Mac, may serve where Paradev keeps a machine running.
- Not its sign-in as the key to a machine, its approval card cut at 600 characters, its relay that reads traffic, or its
  paid plan gate. Manut AI pairs a phone with a code and a passkey, shows each command whole, keeps the channel end to
  end, and asks with Face ID for each Allow (`docs/remote-access.md`).

### What a design for the iOS app should decide

1. Which app: a native one (Swift, or Expo as Paradev's), Tauri 2's iOS target (the same React page and Rust shell), or
   the installed web app kept. Item 111e is the owner's.
2. Whether the end-to-end channel (`packages/remote-channel`, Web Crypto) runs as it is: a web view has Web Crypto, React
   Native would need a crypto dependency. Where the phone's keys live: the Keychain behind Face ID, or IndexedDB as the
   web app keeps them (`docs/web-app.md`, "What Your Mac keeps").
3. Passkeys: whether a native app shares the web app's under the same relying party (associated domains), or pairs again.
4. Push: APNs with the business's Apple developer account, with no content, as Web Push is today (item 78d); the relay's
   threat model wrote its push rows (RT-11, RT-12) for APNs.
5. Live Activities and widgets: which states they show (counts and status words only), and whether the app updates them
   itself, as Paradev's does, or the relay pushes them, which needs APNs tokens kept there.
6. What the phone may do: the levels of `docs/multi-machine.md`, part 11 (Watch, Answer, Work, Terminal, Manage); whether
   it shows diffs and files (item 78 left them out; Paradev's phone reviews diffs with line comments); whether a review's
   notes go to a lane; whether a merge is asked from the phone, as one ask with its passkey.
7. Whether anything of a chat is kept on the phone: the web app keeps nothing, and Paradev's keeps its queries in
   AsyncStorage.
8. The lowest iOS version (Paradev's needs 26; Web Push needs 16.4), and the iPad's layout.
9. How App Review tries it: Practice mode with a pretend Mac, or a reviewer's machine as Paradev's `apps/review-host`.
10. The store listing and signing with the business's Apple developer account, and whether Android comes too (Paradev
    ships one; item 111e).
11. The words in the four languages, with no Thai yet.

## The order

1. What a developer meets in every lane and needs nothing from the owner: setup commands through an ask (145), review in
   the pane (146), a lane from a branch or a request (147), the terminal fixes (148), a lane's files (149), find in a
   chat (150), and a request's review read and handed to Kit (151).
2. What tells the person more: Needs you for an agent in a terminal (152), machine resources (154), the lane's ports (155).
3. What must be designed first because it changes a safety rule or how the app lives: agents through a quit and an
   update (153), Design mode (156), forking a lane (157), replying on GitHub (158), stacks (159), terminal scripts (160), a
   second window (163).
4. The rest: several issues into lanes (161), a board of lanes (162), sparse lanes (164), and the editor (165), which
   waits on the owner's yes to CodeMirror.
5. iOS after macOS, by the owner's goal: the design pass (166), then the owner's choice of app (111e).
