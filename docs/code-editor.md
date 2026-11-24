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
| Lanes: a band with New lane, a row per lane with its title, "Kit, Careful" and a status tag | Part: coding sessions in folder groups, with the agent's mark and what it is doing; no lane words, effort word or status tag | `sessions/SessionsSection.tsx`, `pages/CodePage.tsx` |
| The lane's own branch (`kit/promptpay-qr`): "Kit works on a separate branch. Nothing is live." | Part: the folder's branch is shown, read from `HEAD`; Kit makes no branch of its own | `src-tauri/src/git_branch.rs`, `sessions/SessionView.tsx` (`LiveFoot`) |
| "Checked: 14 tests passed" | Lacks | |
| Revert this turn | Part: the agent's own rewind takes back the last message; the files stay as they are | `sessions/sessions.ts` (`rewind`), `agent_chat.rs` (`Rewind`) |
| Open pull request | Part: Tasks lists pull requests through `gh`; a lane cannot open one | `tasks/` |
| The request, "Edited 3 files and ran 14 tests", Kit's note, the changed files with their counts | Part: the session's timeline shows each step and a file edit's diff | `chat/activity/Work.tsx` (`DiffView`) |
| Tell Kit what to change, add a file, the Code chip | Has: the session's composer, files and modes | `sessions/SessionView.tsx` |
| "Your Claude Code plan" in the composer | Part: a session runs on the developer's own sign-in; the composer names the model, not the plan | `sessions/SessionView.tsx` |
| Diff, Preview and Tests beside the lane | Part: the diff is in the timeline. Lacks the preview and a tests view | |
| The owner sees only the note; a developer gets the diff, the preview and the tests | Lacks: the Code page is the developer's view only | |

## StatesCode: lanes, test output and artifacts

| State | Desktop | Where |
| --- | --- | --- |
| Working: the pill names the real step, with the time | Part: the session row's activity and the timeline's live step | `sessions/termActivity.ts`, `chat/activity/Activity.slot.tsx` |
| Needs you: Kit asks a question, "Answer Kit" | Has: the agent's questions are cards, and Needs you lists them | `chat/cards/Cards.slot.tsx`, `pages/NeedsPage.tsx` |
| Checked, and Tests failed ("1 of 14 tests failed", the test and the wrong value) | Lacks | |
| Reverted, and Bring it back | Lacks | |
| Test output, passing and failing | Part: the terminal and the step show it; nothing reads it | |
| Artifacts: Building, Private preview, Needs you, Live, Rolled back, Failed | Lacks: the Artifacts page is empty. Going live reaches customers (Owner) | `pages/ArtifactsPage.tsx` |

## StatesCodeDev: for developers

### What Kit may do

| State | Desktop | Where |
| --- | --- | --- |
| Kit asks to run a command: Allow once, Always allow in this project, No; "Adds 1 package to the project." | Part: the agent's own asks are cards with Deny, Allow once and Allow for session; nothing says what a command does, and nothing is kept for the project | `chat/cards/Cards.slot.tsx`, `sessions/host.ts` |
| How much Kit does alone: Asks every time, Edits alone, Edits and safe commands, Everything in this project. "Going live always asks, at every level." | Part: the agent's own permission modes (Claude Code's default, plan and acceptEdits; Codex's read-only, ask and auto); no dial of Kit's | `agent_chat.rs` (`modes_for`) |
| Outside the project: blocked and shown, with Allow this folder | Lacks: an agent that asks to read outside its folder gets a card that can allow it | |

### Secrets

| State | Desktop | Where |
| --- | --- | --- |
| Kit needs a secret: typed once into the vault, Kit uses it without seeing it | Lacks on the desktop. The API's vault keeps the shop's sign-ins; the desktop keeps only its own session in the keychain (Owner: real secrets) | `apps/api/src/sign-in-vault.ts`, `src-tauri/src/api_link.rs` |
| A secret found in the code: moved out, never committed | Part: one masker hides token-like text on screen; nothing checks a change before it is saved | `lib/secrets.ts`, `lib/secrets.json` |
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
| Something that keeps running: "Dev server, 42 minutes, port 3000", Stop | Part: a terminal row shows its program's last line and age; there is no list of what keeps running | `sessions/termActivity.ts` |

## KitCode: the parts

Has: the diff (`DiffView`), the terminal output and the code block (the timeline's markdown). Lacks: the lane row, the
mono tags for test results ("Checked: 14 tests passed", "Failed: 1 of 15 tests", "Running tests", "Not run yet") and
the trace with tokens and baht per call.

## Needs the owner

- Adding a project from GitHub, and a check that fails after a pull request: a real GitHub account.
- Your plan at its limit, and using the AI budget for a job: money, and a real plan.
- Signing in to Claude Code again: a real sign-in.
- Kit's secrets in a vault: real secrets, and where they live (the shop's vault in the API, or this Mac's keychain).
- An artifact going live: it reaches customers.
