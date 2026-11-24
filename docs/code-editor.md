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
| Kit asks to run a command: Allow once, Always allow in this project, No; "Adds 1 package to the project." | Has (this branch): a coding session's ask says what the step does, and offers No, Allow once and Always allow in this project, which keeps a rule for the project. The shell names each ask's tool, command line, paths and folder from the agent's own message, and the dial reads those | `src-tauri/src/ask_tool.rs`, `code/command.ts`, `code/ask.ts`, `code/KitCardParts.tsx`, `chat/cards/Cards.slot.tsx` |
| How much Kit does alone: Asks every time, Edits alone, Edits and safe commands, Everything in this project. "Going live always asks, at every level." | Has (this branch): the dial on the Code page, per project, and the asks it settles by itself | `packages/member-grants/src/kit.ts`, `code/KitPanel.tsx`, `code/kitAsks.ts` |
| Outside the project: blocked and shown, with Allow this folder | Has (this branch): denied as it is asked, listed on the Code page, and Allow this folder lets Kit read there | `code/kitAsks.ts`, `code/KitPanel.tsx`, `code/project.ts` |

### Secrets

| State | Desktop | Where |
| --- | --- | --- |
| Kit needs a secret: typed once into the vault, Kit uses it without seeing it | Lacks on the desktop. The API's vault keeps the shop's sign-ins; the desktop keeps only its own session in the keychain (Owner: real secrets) | `apps/api/src/sign-in-vault.ts`, `src-tauri/src/api_link.rs` |
| A secret found in the code: moved out, never committed | Part (this branch): a key in Kit's changes is found and named, a commit or push then asks at every level, and no diff shows it. Moving it to a vault lacks | `code/secrets.ts`, `code/kitAsks.ts`, `chat/activity/Work.tsx` |
| No secret in the preview: a sample until the owner adds one | Part (this branch): the state and its words. A secret Kit's changed code reads by name (`process.env.PROMPTPAY_SHOP_ID`) shows as Sample, "The preview has no shop ID yet, so the QR code is a sample", with Add the shop ID, which says the vault comes later. The rule for what a preview runs with (a sample unless the owner added that secret) is `previewEnv`. There is no preview to run with it yet, and nothing adds a secret: the owner has not said where a developer's secrets live (Owner: real secrets) | `code/preview.ts`, `code/PreviewSample.tsx` |

### The project and its history

| State | Desktop | Where |
| --- | --- | --- |
| Open an existing project: from GitHub or a folder on this Mac; Kit reads it first and changes nothing | Part: a folder can be added and sessions start in it, and plan mode reads without changing. From GitHub lacks (Owner: a real GitHub account) | `sessions/folders.ts` |
| The main branch moved: "1 file needs both changes", Let Kit merge, Show me both | Has (this branch): the Code page says "main changed while Kit worked. 1 file needs both changes." under Kit's dial, with the files. Show me both draws what main changed beside what Kit changed. Let Kit merge sends Kit the ask as a message (no running lane: a new session with the ask in its box); Kit's steps then ask through their own cards. Per project, not per lane row: lanes are not on the page yet | `src-tauri/src/git_moved.rs`, `code/moved.ts`, `code/MainMoved.tsx`, `code/askKit.ts` |
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

- Whether Kit's lanes run as chats in the app, as the canvas's Code board draws them, or only in terminals, as decided
  on 16 November. The dial's asks reach only the first.

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
- `apps/desktop/src-tauri/src/git_moved.rs`: the main branch moving, read with the person's own `git`: the folder's
  branch, the branch it started from, and the files each side changed since. The shell's first `git` call; see below.
- `apps/desktop/src/code/moved.ts`: what that means. The files both sides changed, the shell's answer checked before it is
  believed, one side's diff as the diff view draws it, and the ask Let Kit merge sends. `useMoved.ts` reads it again while
  the page is open, `askKit.ts` sends the ask, `MainMoved.tsx` draws it.
- `apps/desktop/src/code/preview.ts`: the secrets Kit's changed code reads, by name, and `previewEnv`, the one rule for
  what a preview runs with. `PreviewSample.tsx` draws the Sample row.
- The stand-in coding agent (`sessions/host.ts`) answers `/kit install`, `test`, `edit`, `outside`, `key`, `shop`, `merge`,
  `commit` and `deploy`, and the mock host answers what git would say for the canvas's project (`code/mockMoved.ts`), so each
  state can be seen in a browser; `e2e/kit-code.spec.ts` and `e2e/kit-preview-moved.spec.ts` walk them.

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

### How the main branch moving is read

Until this branch the shell ran no `git`: `git_branch.rs` reads `.git/HEAD` as a file and `tasks.rs` runs `gh`. Which files
changed on both sides needs git's own object store, so `session_main_moved` runs the person's own `git` through the runner
Tasks already uses for `gh` (`tasks::run_env`: no shell, nothing on stdin, 20 seconds, a cap on the output). Every call only
reads (`symbolic-ref`, `rev-parse`, `merge-base`, `diff`, `ls-files`), none takes the index lock (`GIT_OPTIONAL_LOCKS=0`, so
Kit's own `git commit` never meets it), a path is never a pathspec (`GIT_LITERAL_PATHSPECS=1`), and a branch name from the
page is checked before it reaches an argument. The shell answers with names and commit ids; a diff only when asked, for a
path both sides changed, with keys masked as every CLI answer in `tasks.rs` is.

- The lane is the branch the folder has checked out. The branch it started from is the one `origin/HEAD` points at, else
  `main`, else `master` (a local branch before its copy from `origin`). The page may name one (`base`).
- Since the two parted, the lane's side is what its commits, the staging area and the work tree changed, with files git does
  not track yet; the other side is what the base changed. A rename counts as a delete and an add, so a file one side moved and
  the other edited needs both changes.
- The note shows when at least one file needs both changes. A base that moved without touching the lane's files shows nothing:
  git merges that by itself.
- Read when a project opens on the Code page, when the window is looked at again, and once a minute.

Let Kit merge sends Kit a message, `mergeAsk`: merge the base into the branch, these files changed on both sides, fix any
clash, run the tests, show the result as a diff, and push nothing until told. It goes to the project's newest session that
runs as a chat (`send`), so every step Kit takes arrives as an ask card and is answered through `settleApproval` at the level
the developer chose; `git merge` is a change that rewinding takes back, a push is a push. With no such session, a new session
opens in the project with the ask in its box and nothing starts until the person presses Start (a session in its own terminal
keeps its agent's prompts in the terminal, so the ask is never typed into one).

### How a preview with no secret is read

A project needs a secret to show something when a line Kit changes reads one from the environment by a name that says what
it is: a shop ID (`PROMPTPAY_SHOP_ID`, `SHOP_ID`, `MERCHANT_ID`) or a key, token, secret or password. Only the name is kept,
never a value, and only code Kit changed (its `tool.diff` events). `previewEnv` is the one rule for what a preview runs with:
a sample for every secret unless the owner added that very secret. Nothing else can put a real one in: not this computer's
environment, not a value found in the code. The sample for a shop ID is all zeros, so no payment can reach an account.

The app has no preview of its own yet, so nothing runs with `previewEnv` today; a preview started by the app must use it. And
nothing saves a secret: Add the shop ID says the vault comes later.

## Left for later (no owner needed)

- The dial for a session in its own terminal: the shell starting the agent with the permission mode and allowed
  commands the dial gives (Claude Code's `--permission-mode` and `--allowedTools`). That is Rust, and it widens the
  shell's fixed list of arguments, so it wants its own review.

- Rewinding a turn, files and chat together: the agents' own rewind takes back the chat only. The shell needs to keep
  the files as they were when a turn starts (a stash-like snapshot) and put them back; that is Rust.
- Lanes on a branch of their own, and the lane's states (Checked, Tests failed, Reverted), with a test run's result
  read from its output. A lane that records the branch it started from can pass it to `session_main_moved` (it takes a
  `base`), and the main-moved note can then sit on its row instead of under the project's dial.
- The main branch moving: the merge's result shown by the app as a diff after Kit merges (today Kit is asked to show it, and
  asked not to push), and a file both sides changed in the very same way is still counted as needing both changes.
- Something that keeps running: the commands still running, with their age, port and Stop.
- The preview itself: the project run beside the lane, started with `previewEnv`, so a secret it reads is a sample. Reading
  what a project needs from its `.env.example` as well as from Kit's changes.
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
