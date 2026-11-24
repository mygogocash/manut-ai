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
| Revert this turn | Has (this branch): Rewind, on the line under the box beside the branch, puts back the files and the chat of a kept turn; the newest is picked first. Claude Code and Codex only. The agent's own Edit on the last message still takes back the chat only | `sessions/RewindPanel.tsx`, `sessions/rewind.ts`, `src-tauri/src/turn_files.rs` |
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
| Reverted, and Bring it back | Part (this branch): after a rewind the chat says "Rewound to before “Thai date format”. 3 files are back as they were." Bring it back lacks | `sessions/rewind.ts` (`rewoundNote`) |
| Test output, passing and failing | Part: the terminal and the step show it; nothing reads it | |
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
| Rewind: pick a turn; the files and the chat go back together | Has (this branch): see [Rewind to before a turn](#rewind-to-before-a-turn) | `sessions/RewindPanel.tsx`, `sessions/rewind.ts`, `src-tauri/src/turn_files.rs` |

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

- Whether Kit's lanes run as chats in the app, as the canvas's Code board draws them, or only in terminals, as decided
  on 16 November. The dial's asks, and Rewind to before a turn, reach only the first.

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

Kit's dial acts on the asks of a coding session that runs as a chat in the app, whose asks arrive as cards: the
canvas's Code board draws Kit's lane that way ("Tell Kit what to change", Kit's note). Since 16 November the Code
page's + menu starts agents in their own terminal only, where an agent's prompts stay inside the terminal, so the dial
does not reach those sessions yet. The Code page shows the dial for every project either way.

Words the shell would expand are never read as what they look like: an unquoted pattern (`*`, `?`, `[`) or brace
list (`{a,b}`, `{1..3}`) makes a command unreadable, so it asks at every level (`lex` in `src/code/command.ts`).

## Rewind to before a turn

The canvas's StatesCodeDev "Rewind": "The files and the chat go back together. Every turn can be undone as a whole.
Nothing live changes." It works for a coding session that runs as a chat in the app with Claude Code or Codex, the two
agents that can take their chat back to a chosen message.

- **A snapshot when a turn starts.** Before a message that starts a turn goes to the agent, the shell keeps the session
  folder's files as they are (`src-tauri/src/turn_files.rs`). It keeps them again when the turn ends, so a rewind can
  tell what the agent changed from what changed by hand between turns.
  - In a git repository, in git's own objects: each file's bytes as a blob (no filter, no line-ending change), and each
    snapshot as a tree under a ref of the app's own, `refs/manut/snapshots/<session>/<n>`, built in an index file of
    the app's own. The developer's branches, index, stash and HEAD never change. A ref that names a tree, not a commit,
    stays out of `git log --all` and every history view, and `git gc` keeps what it names. `git for-each-ref` lists it.
  - In any other folder, or when git cannot run, as a copy in the app's data folder,
    `~/.manut/turn-snapshots/<session>/blobs/<sha256>`, each content once, readable by this account only.
  - Either way each snapshot's list of files is in `~/.manut/turn-snapshots/<session>/`.
- **What is left out**, never kept and never touched by a rewind:
  - in a repository, what git ignores, and a `node_modules` git does not ignore;
  - in any other folder, which has no ignore rules to read, the folders a project rebuilds: `node_modules`,
    `bower_components`, `target`, `dist`, `build`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.parcel-cache`, `.cache`,
    `coverage`, `__pycache__`, `.venv`, `venv`, `.tox`, `.pytest_cache`, `.mypy_cache`, `.gradle`, `Pods`,
    `DerivedData`, `.dart_tool`, `.expo`, `.terraform` and `.git`;
  - everywhere, `.DS_Store`, `Thumbs.db` and `desktop.ini`, files over 50 MB, and a name with a line break in it.
- **Bounds.** A folder with more than 50,000 files, or more than 1 GB in them, gets no snapshot, and the panel says its
  turns cannot be rewound. A message waits at most 20 seconds for its turn's files; when keeping them takes longer, the
  message goes and that turn is not offered. A session keeps its newest 20 turns. Its snapshots go when the session is
  closed and when its agent starts again (a new process can take back only the messages it was sent itself). When the
  app starts, the snapshots of sessions that are gone go too.
- **Rewind** (`sessions/RewindPanel.tsx`): pick a turn, read what goes back, press Rewind once. The shell keeps the files as
  they are, then puts that turn's snapshot back. Then the agent takes the chat back to before that message (`rewind_to`:
  Claude Code's `rewind_conversation` to that message, Codex's `thread/revert` to before its turn). When the agent refuses,
  or does not answer within 30 seconds, the files go back as they were. After a rewind the box holds that message's
  words, as the agent's own Edit does, and the chat says how many files went back.
- **Changed by hand.** A file that changed outside the agent's turns since that turn is listed, and stays as it is unless
  the person unticks it. A change made while a turn runs counts as the agent's. When a turn's end was not seen (the app
  closed in the middle of it), all of that turn's changes are listed as changed by hand, so none is missed.
- **Nothing live changes.** A rewind writes files in the session's folder only. It never moves a branch and never touches
  a remote. When a step since the turn pushed, published or deployed (as Kit's command reader reads it,
  `code/command.ts`), the panel says rewinding does not take that back. When the branch has new commits since, it says
  the files go back and the commits stay.

## Left for later (no owner needed)

- The dial for a session in its own terminal: the shell starting the agent with the permission mode and allowed
  commands the dial gives (Claude Code's `--permission-mode` and `--allowedTools`). That is Rust, and it widens the
  shell's fixed list of arguments, so it wants its own review.

- Bring it back, after a rewind (StatesCode "Reverted"). The files from before a rewind are kept only until the agent
  answers it.
- Rewinding a turn sent before the app restarted, or before the agent started again: Claude Code and Codex take back only
  the messages their running process was sent, so those turns are not offered.
- Rewind for a session in its own terminal, or with an agent other than Claude Code and Codex: the first sends no message
  through the app, and the others have no rewind of their own.
- Lanes on a branch of their own, and the lane's states (Checked, Tests failed, Reverted), with a test run's result
  read from its output.
- The main branch moving while Kit worked, with Let Kit merge and Show me both.
- Something that keeps running: the commands still running, with their age, port and Stop.
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
