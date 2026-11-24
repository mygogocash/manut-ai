# The code editor

What a developer meets when they open the hood, or when they use Manut AI for their own software: the design
canvas's Code, StatesCode, StatesCodeDev and KitCode boards (roadmap Phase 6, "the full code editor"). Kit is the
coding engineer. A shop owner sees a note and a button; a developer sees the lanes, the diff, the tests and the
terminal.

The desktop's Code page (`apps/desktop/src/pages/CodePage.tsx`) is the fork's coding sessions and terminals, grouped by
folder (`src/sessions/`), then the Tasks row (`src/tasks/`). A coding session runs the developer's own agent (Claude
Code, Codex, pi and others) in a folder on this Mac, through the shell (`src-tauri/src/agent_chat.rs`).

Each state below says whether the desktop **has** it, has **part** of it, or **lacks** it, and where. **Owner** marks a
state that needs the owner: a real GitHub account, money, a real sign-in or real secrets.

## The Code board: a lane open

| State | Desktop | Where |
| --- | --- | --- |
| Lanes: a band with New lane, a row per lane with its title, "Kit, Careful" and a status tag | Part (this branch): the Kit panel opens with a Lanes band, a row for each coding session that runs as a chat, with its title, "Kit · Claude Code", its branch and a state tag. Terminals stay in their folder groups below. No New lane and no effort word | `code/Lanes.tsx`, `code/KitPanel.tsx` |
| The lane's own branch (`kit/promptpay-qr`): "Kit works on a separate branch. Nothing is live." | Has (this branch): a chat session gets a branch of its own as it starts, named from its first message and made from the branch the folder is on, so the developer's branch is not written to. The row and the composer's foot show it. Nothing is pushed or merged from here | `code/laneBranch.ts`, `src-tauri/src/lane.rs`, `sessions/sessions.ts` (`startLane`) |
| "Checked: 14 tests passed" | Has (this branch): read from the test run's output (vitest, jest, node's own runner, pytest, `go test`, `cargo test`). A run that cannot be read is Not confirmed, never Checked | `code/testRun.ts`, `code/lane.ts` |
| Revert this turn | Part (this branch): the agent's own rewind takes back the last message, and the lane says Reverted; the files stay as they are | `sessions/sessions.ts` (`rewind`), `agent_chat.rs` (`Rewind`), `code/lane.ts` |
| Open pull request | Part: Tasks lists pull requests through `gh`; a lane cannot open one | `tasks/` |
| The request, "Edited 3 files and ran 14 tests", Kit's note, the changed files with their counts | Part: the session's timeline shows each step and a file edit's diff | `chat/activity/Work.tsx` (`DiffView`) |
| Tell Kit what to change, add a file, the Code chip | Has: the session's composer, files and modes | `sessions/SessionView.tsx` |
| "Your Claude Code plan" in the composer | Part: a session runs on the developer's own sign-in; the composer names the model, not the plan | `sessions/SessionView.tsx` |
| Diff, Preview and Tests beside the lane | Part: the diff is in the timeline. Lacks the preview and a tests view | |
| The owner sees only the note; a developer gets the diff, the preview and the tests | Lacks: the Code page is the developer's view only | |

## StatesCode: lanes, test output and artifacts

| State | Desktop | Where |
| --- | --- | --- |
| Working: the pill names the real step, with the time | Has (this branch): the lane's tag names the agent's own step ("Running tests" while a test run runs) with the time, and its line says Kit works on a separate branch and nothing is live | `code/Lanes.tsx`, `chat/activity/Activity.slot.tsx` |
| Needs you: Kit asks a question, "Answer Kit" | Has: the agent's questions are cards, and Needs you lists them. The lane says "Kit asks: …" with Answer Kit (this branch) | `chat/cards/Cards.slot.tsx`, `pages/NeedsPage.tsx`, `code/Lanes.tsx` |
| Checked, and Tests failed ("1 of 14 tests failed", the test and the wrong value) | Has (this branch): "14 tests passed" and "1 of 14 tests failed. Nothing is live.", with the failing tests named. The wrong value is in the terminal; the lane does not keep a test's output | `code/lane.ts`, `code/Lanes.tsx` |
| Reverted, and Bring it back | Part (this branch): Reverted, with the time and "The files stay as they are". Bring it back lacks, since the files were never taken back | `code/lane.ts` |
| Test output, passing and failing | Part: the terminal and the step show it; the lane reads its result and keeps none of it | `code/testRun.ts` |
| Artifacts: Building, Private preview, Needs you, Live, Rolled back, Failed | Lacks: the Artifacts page is empty. Going live reaches customers (Owner) | `pages/ArtifactsPage.tsx` |

## StatesCodeDev: for developers

### What Kit may do

| State | Desktop | Where |
| --- | --- | --- |
| Kit asks to run a command: Allow once, Always allow in this project, No; "Adds 1 package to the project." | Has (this branch): a coding session's ask says what the step does, and offers No, Allow once and Always allow in this project, which keeps a rule for the project. The shell names each ask's tool, command line, paths and folder from the agent's own message, and the dial reads those | `src-tauri/src/ask_tool.rs`, `code/command.ts`, `code/ask.ts`, `code/KitCardParts.tsx`, `chat/cards/Cards.slot.tsx` |
| How much Kit does alone: Asks every time, Edits alone, Edits and safe commands, Everything in this project. "Going live always asks, at every level." | Has (this branch): the dial on the Code page, per project, and the asks it settles by itself | `packages/member-grants/src/kit.ts`, `code/KitPanel.tsx`, `code/kitAsks.ts` |
| Outside the project: blocked and shown, with Allow this folder | Has (this branch): denied as it is asked, listed on the Code page, and Allow this folder lets Kit read there | `code/kitAsks.ts`, `code/KitPanel.tsx`, `code/project.ts` |

### Secrets

| State | Desktop | Where |
| --- | --- | --- |
| Kit needs a secret: typed once into the vault, Kit uses it without seeing it | Lacks on the desktop. The API's vault keeps the shop's sign-ins; the desktop keeps only its own session in the keychain (Owner: real secrets) | `apps/api/src/sign-in-vault.ts`, `src-tauri/src/api_link.rs` |
| A secret found in the code: moved out, never committed | Part (this branch): a key in Kit's changes is found and named, a commit or push then asks at every level, and no diff shows it. Moving it to a vault lacks | `code/secrets.ts`, `code/kitAsks.ts`, `chat/activity/Work.tsx` |
| No secret in the preview: a sample until the owner adds one | Lacks: there is no preview | |

### The project and its history

| State | Desktop | Where |
| --- | --- | --- |
| Open an existing project: from GitHub or a folder on this Mac; Kit reads it first and changes nothing | Part: a folder can be added and sessions start in it, and plan mode reads without changing. From GitHub lacks (Owner: a real GitHub account) | `sessions/folders.ts` |
| The main branch moved: "1 file needs both changes", Let Kit merge, Show me both | Lacks | |
| A check failed after the pull request: "Pull request 12: lint failed. Tests passed." | Part: Tasks reads a pull request's checks through `gh`; the lane does not show them (Owner: a real GitHub account to try it) | `tasks/TasksPage.tsx` |
| Rewind: pick a turn; the files and the chat go back together | Part: the chat only, through the agent's rewind | `sessions/sessions.ts` |

### Your own AI plan

| State | Desktop | Where |
| --- | --- | --- |
| Working on your plan: "Costs nothing from the AI budget." | Part: sessions run on the developer's own sign-in; nothing says so | |
| Your plan is at its limit: Wait, or use the AI budget for this job | Lacks (Owner: money, and a real plan to see the limit) | |
| Your plan needs a sign-in | Part: a session that is not signed in says so and points to Settings › Accounts (Owner: a real sign-in to try it) | `sessions/sessions.ts` (`signedOutSaid`) |

### Watching it run

| State | Desktop | Where |
| --- | --- | --- |
| The terminal: Kit runs commands here, and you can type too | Has | `sessions/term/`, `terminal/Panel.tsx` |
| Something that keeps running: "Dev server, 42 minutes, port 3000", Stop | Has (this branch): a list under Kit's panel, for the project it shows, of each command a terminal or a chat started that still runs, with the command, how long it has run, its port and Stop (see "What keeps running" below). Not on Windows | `running/RunningPanel.tsx`, `src-tauri/src/running.rs` |

## KitCode: the parts

Has: the diff (`DiffView`), the terminal output and the code block (the timeline's markdown), and (this branch) the lane
row and its mono branch tag. Part: the test results are the lane's own tags ("Checked", "Tests failed", "Not run yet",
and "Running tests" in the working tag) with their counts in the line under the row, not the canvas's one tag
("Checked: 14 tests passed"). Lacks: the trace with tokens and baht per call.

## Needs the owner

- Whether Kit's lanes run as chats in the app, as the canvas's Code board draws them, or only in terminals, as decided
  on 16 November. The dial's asks reach only the first, and so do the lanes: the + menu starts terminals only, so the
  Lanes band is empty until a chat session exists.

- Adding a project from GitHub, and a check that fails after a pull request: a real GitHub account.
- Your plan at its limit, and using the AI budget for a job: money, and a real plan.
- Signing in to Claude Code again: a real sign-in.
- Kit's secrets in a vault: real secrets, and where they live (the shop's vault in the API, or this Mac's keychain).
- An artifact going live: it reaches customers.

## What this branch builds

The states whose rules are pure functions, with their tests, then the screens that show them:

- `packages/member-grants/src/kit.ts`: Kit's dial (`kitDecide`), on top of `decide`.
- `apps/desktop/src/code/command.ts`: a command read before it runs: its kind of step, the paths outside the project,
  the rule "Always allow" would keep, and what it does in words.
- `apps/desktop/src-tauri/src/ask_tool.rs`: what each ask is, named by the shell from the agent's own message (`tool`
  on the ask): the kind of step, a command's whole line, every path a file tool names, and the folder it runs in.
- `apps/desktop/src/code/ask.ts`: a session's ask read by what the shell names, and decided by the dial. An ask that
  names nothing is read by the words the shell writes on it.
- `apps/desktop/src/code/project.ts`: each project's level, kept rules, folders Kit may read and stopped steps, on this
  computer.
- `apps/desktop/src/code/secrets.ts`: keys in Kit's changes, counted with the app's one masker.
- `apps/desktop/src/code/kitAsks.ts`: the dial at work on a session's asks, through the asks' own cards.
- `apps/desktop/src/code/KitCardParts.tsx`, `KitPanel.tsx`, `kit.css`: Kit's words on an ask's card, and Kit on the
  Code page.
- The stand-in coding agent (`sessions/host.ts`) answers `/kit install`, `test`, `edit`, `outside`, `key`, `commit` and
  `deploy`, so each state can be seen in a browser; `e2e/kit-code.spec.ts` walks them.
- `apps/desktop/src/code/testRun.ts`: a test run read from its words (does a command run tests, and which runner it
  names) and from its output (vitest, jest, node's own runner, pytest, `go test`, `cargo test`): passed, failed with how
  many and which, or unknown.
- `apps/desktop/src/code/laneBranch.ts` and `src-tauri/src/lane.rs`: a lane's branch named from its work, planned, and
  made by the shell with `git checkout -b`.
- `apps/desktop/src/code/lane.ts`, `laneStore.ts`: what a lane's events showed, the state the owner reads from it, and
  the line under the row. `Lanes.tsx` draws the band in the Kit panel.
- `src-tauri/src/agent_chat.rs`: a command's step hands on the end of what it printed with its `tool.end` (Claude Code
  and Codex), or says `declined` when the person said no and it never ran.
- The stand-in agent also answers `/kit pass`, `fail`, `unread` and `slow`: an edit, then a test run whose output comes
  with the step's end. `e2e/kit-lanes.spec.ts` walks each state.

### How an ask is read

An ask's title and command are for the person: the shell cuts them to one short line. So the shell also names what
the agent asked, from the agent's own message, and the dial reads that:

| Agent | Where it comes from | What is named |
| --- | --- | --- |
| Claude Code | its permission request (`can_use_tool`) | the tool, a command's line, a file tool's path, the path Claude Code found outside its folders (`blocked_path`). A command that asks to leave Claude Code's sandbox (`dangerouslyDisableSandbox`) is left to the person |
| Codex | the request, and the file change it names | the script inside Codex's `zsh -lc '…'`, the folder Codex names, every changed file, where a move takes a file, the folder Codex asks to keep writing under |
| OpenCode and the other ACP agents | the call's own `kind` and input (`rawInput`) | a command's line and the folder it names, a file tool's path |
| oh-my-pi | the one running call of the tool its dialog names | a command's line, a file tool's path |

A part the shell cannot read whole is left out: a line over 10,000 characters, more than 200 paths, a shell wrapper
that is not one plainly quoted script. Then the dial does not decide: the card asks the person. It never falls back to
the title's words for an ask that names its tool.

What this changes: a command on two lines is read as two commands, not as the one line its card shows (`pnpm test`
then `git push origin main` asks at every level; by its card it read as the tests, which run alone); a kept rule must
match the whole line; a long list of files is read whole, with where a move takes a file; and a file change that
deletes a file is a delete, which only Everything in this project lets Kit do alone.

### How a lane is read

A lane is a coding session that runs as a chat. `laneStatus` (`code/lane.ts`) alone decides its state, from what the
session's events showed and what the app already knows:

| State | When | The row says |
| --- | --- | --- |
| Needs you | an ask of the lane waits | "Kit asks: …" and Answer Kit |
| Working | a turn runs | Kit works on a separate branch. Nothing is live. The tag names the step and the time, or Running tests |
| Failed | the session could not start, or ended in an error | its own words |
| Reverted | the person took the last turn back and no turn has started since | when, and that the files stay as they are |
| Checked | the last test run passed, and no file changed after it | "14 tests passed." |
| Tests failed | the last test run failed | "1 of 14 tests failed. Nothing is live." and the failing tests |
| Not confirmed | the last test run could not be read | that the result could not be read, and that nothing is marked as passed |
| Not run yet | no test ran, or a file changed after the last run | nothing, or that the code changed after the last run |

A test run is a command step whose words run tests (`runsTests`: `pnpm test`, `vitest run`, `cd app && go test ./...`).
The dial's own reading of a command is stricter, since it decides what Kit may do alone, and is not used for this. When
the step ends, its output is read and thrown away: only the counts and the failing tests' names are kept, with a key
masked. A run is read as passed only when its output says tests ran, says none failed, and its command did not end in an
error. Anything else the parser cannot read is Not confirmed. A failure is read from the output whatever the exit status
says, since `vitest run || true` hides it from the status and not from the output. A file that changes after a run makes
its result old: the lane then says Not run yet, whatever the run said.

The shell hands on the last 8 KiB of a command's output with its step's `tool.end` (`output`), for Claude Code and Codex,
and the whole command line (`command`: the step's start cuts it to 160 characters, and a long folder before `pnpm test`
would hide it). The other agents hand on none, so their test runs are Not confirmed. A step the person refused says
`declined`, and is no test run.

A lane's branch is made by the shell (`lane_branch`, `src-tauri/src/lane.rs`) as the session starts and before the agent
runs: `git checkout -b kit/<words>` from the branch the folder is on, with a fixed argument list and a name checked
against the one form Kit makes. No file changes, and nothing is pushed, fetched, merged or deleted. It refuses a
folder that is not a repository, one with no commit, one in the middle of a rebase, merge, cherry-pick, revert or
bisect, and one whose index is locked; the lane then has no branch of its own and its row says it works on the folder's.
A folder has one checkout, so a lane that starts while another is working or waiting in the folder joins that lane's
branch, and its row says so. If the folder is on some other branch when a lane's turn ends, the row shows that branch.

Kit's dial acts on the asks of a coding session that runs as a chat in the app, whose asks arrive as cards: the
canvas's Code board draws Kit's lane that way ("Tell Kit what to change", Kit's note). Since 16 November the Code
page's + menu starts agents in their own terminal only, where an agent's prompts stay inside the terminal, so the dial
does not reach those sessions yet. The Code page shows the dial for every project either way.

Words the shell would expand are never read as what they look like: an unquoted pattern (`*`, `?`, `[`) or brace
list (`{a,b}`, `{1..3}`) makes a command unreadable, so it asks at every level (`lex` in `src/code/command.ts`).

## What keeps running

The Code page lists the commands that this app's own terminals and chats started and that still run, under Kit's
panel and for the project that panel shows (`src/running/`, mounted by `code/KitPanel.tsx`, so picking another project
there switches the list). Each row has the command, how long it has run, the port it listens on if there is one, and
Stop. A line under the list counts what runs in the other projects, so a dev server left in one is never out of sight. The canvas draws it in StatesCodeDev, "Watching it run": a Running tag, "Dev server, 42 minutes, port 3000" and
a Stop button. It draws no question before Stop, so there is none.

**Where it comes from.** The shell holds the program of each terminal (`Sessions`) and each chat (`ChatSessions`).
Nothing it already sent says what they started: `session-fg` names only an agent, and a chat's `background` is a
count. So `src-tauri/src/running.rs` walks down from those programs through the processes they started (libproc on
macOS, `/proc` on Linux, no program run) and reads nothing else. The page asks (`running_list`, nothing sent) every 3
seconds while the Code page shows and the window is visible, and the shell answers with each command's session,
folder, process id, start time, arguments and ports. A process's environment is never kept or sent.

**What is a command.** Under a login shell (a Shell terminal), whatever its person ran from it; a shell they started
inside it is not one, but what it ran is. Under an agent (a chat, or an agent in a terminal), only what it ran through
its own shell, `sh -c …`, which is how Claude Code (seen in a live process list) and Codex (`zsh -lc '…'`) run a command;
an agent that runs commands another way is not read yet. An agent run from a Shell terminal is an agent, not a command. The MCP servers an agent keeps for its whole session, its language servers and its other
helpers are not commands: a list that showed them, with a Stop, would be a list nobody trusts. A command is listed once
it has run 5 seconds, so a `git status` never flickers in; a dev server is listed 5 seconds after it starts.

**What a row shows.** The command as a person recognises it: a program by its own name and arguments, a node script by
its package (`pnpm dev`, not `node …/pnpm.cjs dev`), a shell's `-c` as the script it was given, and Claude Code's wrapper
(`source snapshot … && eval '<the command>' < /dev/null && pwd -P >| …`) as the command inside it. Any key in it is
hidden with the cards' masker (`maskSecrets`), and only then is a long command cut at 160 characters, so a cut cannot
leave the front of a key too short for the masker to know. Then how long it has run (the system's own start time; the
app's `elapsed` and `duration` words), and the ports: the TCP ports the command, or anything it started, listens on
(`pnpm dev` listens through the `node` two levels down), as "port 3000" or "ports 5173, 24678", with the rest counted.
A command names the session it runs in, which opens it: a terminal as its row is named, and a chat, which is a lane, as
its lane is (`chatIdOf` beside `ptyOf` gives the shell's id for each). A shell of the bottom panel has no session here, so
its commands name none. Rows are oldest first, and stay in that order.

**Stop** ends the command and everything it started: SIGTERM to each, parent first, and SIGKILL three seconds later to
whatever still runs. The page tells the shell only which command it is (kind of session, session id, process id, start
time), never its words. The shell finds that command under that session again before it signals, and signals each
process only if it is still the one it listed (same program, same start time), so a number the page made up, a process
that took a finished one's number, a session's own shell, a process deeper in a command's tree, and anything outside the
app's own sessions are never touched. After Stop the row says Stopping until the command is gone; if it is still there
after 10 seconds the button comes back, with "Could not stop it. Try again."

**Files.** `src-tauri/src/running.rs` (the walk, its tests with a table of processes and with real ones, `running_list`
and `running_stop` in `lib.rs`; `Sessions::roots` and `ChatSessions::roots` give the programs; `fg.rs` lends its readers).
`src/running/model.ts` (the words of a row), `feed.ts` (the polling and Stop's states), `host.ts` (the shell, and a mock
for a browser: `window.__manutMockRunning` seeds it and `window.__manutRunningCalls` records each stop),
`RunningPanel.tsx` and `running.css`. `e2e/running.spec.ts` walks it in a browser, with Kit's panel and its project picker.

## Left for later (no owner needed)

- The dial for a session in its own terminal: the shell starting the agent with the permission mode and allowed
  commands the dial gives (Claude Code's `--permission-mode` and `--allowedTools`). That is Rust, and it widens the
  shell's fixed list of arguments, so it wants its own review.

- Rewinding a turn, files and chat together, and the lane's Bring it back: the agents' own rewind takes back the chat
  only. The shell needs to keep the files as they were when a turn starts (a stash-like snapshot) and put them back; that
  is Rust.
- Lanes that work at once in one folder, each on its own branch: a working folder for each lane (a git worktree). Today a
  second lane joins the branch of the first while that one works, and a lane that starts after it is made from where the
  folder is, so it stacks on the earlier lane's work.
- The developer's own uncommitted changes in the folder come along when a lane's branch is made (a new branch has the
  same tree). Saying so on the lane, or asking first, wants a decision.
- Test output from OpenCode and the other ACP agents, and from pi: their steps hand on none, so their runs are Not
  confirmed. More runners than the six (mocha, Playwright, `unittest`).
- Open pull request and Ask Kit to fix it on a lane, a tests view beside it, the effort word and New lane. A pull request
  needs a push, which asks; New lane waits on the owner's call on chats and terminals.
- A lane after a restart: a chat session that comes back has no lane, since chat sessions are not listed after one.
- The main branch moving while Kit worked, with Let Kit merge and Show me both.
- What keeps running, inside an open session: the list is on the Code page, for the project Kit's panel shows, and an
  open session does not show its own commands. Also: Windows has no reader, so the page draws nothing there; a command
  that left its parent for good (a daemon) is no longer found; a long-lived `sh -c` that an agent keeps for its own use
  would be listed as a command; and so might a helper a shell's startup file leaves running (not seen yet).
- A preview with sample values until the owner adds a real one.
- Where Claude Code's shell is. Its ask does not say, and a `cd` in one command carries to the next inside the project
  and the session's attachments folder (the shell adds it with `--add-dir`), so the dial reads a command from the
  session's folder. It does check the path Claude Code itself found outside. Starting Claude Code with
  `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` would start every command in the project; that changes how the
  developer's own agent works, so it wants its own decision.
- Asks that still name no path, so they ask the person: a search that names no folder, or a Glob whose pattern
  reaches past its folder; oh-my-pi's own edit, which names its file inside its patch; and an ACP agent's search or
  move.
- Kit asking for a secret, kept in this Mac's keychain without Kit seeing it: a keychain item per project, written from
  a password field and handed only to the commands that need it. That is Rust, and real secrets need the owner.
