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
| Lanes: a band with New lane, a row per lane with its title, "Kit, Careful" and a status tag | Part (this branch): the Kit panel opens with a Lanes band, a row for each coding session that runs as a chat, with its title, "Kit · Claude Code", its branch and a state tag. Terminals stay in their folder groups below. Under the lanes, Kit's folders kept: a lane's folder that outlived its session, with Show folder and Remove. No New lane and no effort word | `code/Lanes.tsx`, `code/KeptLanes.tsx`, `code/KitPanel.tsx` |
| The lane's own branch (`kit/promptpay-qr`): "Kit works on a separate branch. Nothing is live." | Has (this branch): a chat session gets a branch of its own as it starts, named from its first message and made from the branch the developer's folder is on, checked out in a folder of its own (a git worktree under `~/.manut/lanes`), where its agent works. Several lanes work at once, none touching another's files or the developer's folder, whose branch, index, stash and HEAD never change because of a lane. The row and the composer's foot show the branch. Nothing is pushed or merged from here. See [Where a lane works](#where-a-lane-works) | `code/laneBranch.ts`, `src-tauri/src/lane.rs`, `sessions/sessions.ts` (`startLane`) |
| "Checked: 14 tests passed" | Has (this branch): read from the test run's output (vitest, jest, node's own runner, pytest, `go test`, `cargo test`, mocha, Playwright Test and Python's `unittest`). A run that cannot be read is Not confirmed, never Checked | `code/testRun.ts`, `code/lane.ts` |
| Revert this turn | Has: Rewind, on the line under the box beside the branch, puts back the files and the chat of a kept turn; the newest is picked first. Claude Code and Codex only. The agent's own Edit on the last message still takes back the chat only, and then the lane says the files stay as they are | `sessions/RewindPanel.tsx`, `sessions/rewind.ts`, `src-tauri/src/turn_files.rs`, `code/lane.ts` |
| Open pull request | Part: Tasks lists pull requests through `gh`; a lane cannot open one | `tasks/` |
| The request, "Edited 3 files and ran 14 tests", Kit's note, the changed files with their counts | Part: the session's timeline shows each step and a file edit's diff, and (this branch) the pane beside a lane lists the changed files with their counts. No line that counts the files and the tests together | `chat/activity/Work.tsx` (`DiffView`), `code/LanePane.tsx` |
| Tell Kit what to change, add a file, the Code chip | Has: the session's composer, files and modes | `sessions/SessionView.tsx` |
| "Your Claude Code plan" in the composer | Part: a session runs on the developer's own sign-in; the composer names the model, not the plan | `sessions/SessionView.tsx` |
| Diff, Preview and Tests beside the lane | Part (this branch): the chat of a lane has a pane beside it, "What to look at", with the chips Diff, Preview and Tests, Diff first; it goes under the chat when the column is too narrow for both. Diff: each file the session changed, its newest change with the added and removed counts, drawn as the timeline draws a change. Tests: the last finished run's result as the lane read it, when it finished, the command that ran it, whether a file changed since, and any run in progress; none of the run's output, which the lane never kept. Preview: that the app has no preview of its own yet, and the Sample rows of the secrets Kit's changed code reads. Lacks the preview itself: nothing is started. See [The pane beside a lane](#the-pane-beside-a-lane) | `code/LanePane.tsx`, `code/changes.ts`, `code/lanepane.css`, `sessions/SessionView.tsx` (`LaneSplit`) |
| The owner sees only the note; a developer gets the diff, the preview and the tests | Lacks: the Code page is the developer's view only | |

## StatesCode: lanes, test output and artifacts

| State | Desktop | Where |
| --- | --- | --- |
| Working: the pill names the real step, with the time | Has (this branch): the lane's tag names the agent's own step ("Running tests" while a test run runs) with the time, and its line says Kit works on a separate branch and nothing is live | `code/Lanes.tsx`, `chat/activity/Activity.slot.tsx` |
| Needs you: Kit asks a question, "Answer Kit" | Has: the agent's questions are cards, and Needs you lists them. The lane says "Kit asks: …" with Answer Kit (this branch) | `chat/cards/Cards.slot.tsx`, `pages/NeedsPage.tsx`, `code/Lanes.tsx` |
| Checked, and Tests failed ("1 of 14 tests failed", the test and the wrong value) | Has (this branch): "14 tests passed" and "1 of 14 tests failed. Nothing is live.", with the failing tests named. The wrong value is in the terminal; the lane does not keep a test's output | `code/lane.ts`, `code/Lanes.tsx` |
| Reverted, and Bring it back | Has (this branch): after Rewind the chat says "Rewound to before “Thai date format”. 3 files are back as they were.", and the lane says Reverted with the time, that the files are back, and Bring it back, while the shell still keeps the files from before the rewind (until the next turn starts). Bring it back opens a panel under the row: how many files go back, the files changed by hand since the rewind (kept unless unticked), and that the chat stays where the rewind left it. After it the lane reads by its tests again with "You brought the files back at 10:02. The chat stays where the rewind left it." After the agent's own Edit, which takes back only the chat, the lane says the files stay as they are and offers nothing. See [Bring it back](#bring-it-back-after-a-rewind) | `code/BringBack.tsx`, `code/lane.ts`, `code/Lanes.tsx`, `sessions/rewind.ts`, `src-tauri/src/turn_files.rs` |
| Test output, passing and failing | Part (this branch): the terminal and the step show the output. The lane reads its result (vitest, jest, node's own runner, pytest, `go test`, `cargo test`, mocha, Playwright Test, `unittest`) and keeps none of the output; the Tests view beside the lane shows what it read: the count, the failing tests' names, when the run finished and its command. The wrong value is in the terminal | `code/testRun.ts`, `code/lane.ts`, `code/LanePane.tsx` |
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
| The main branch moved: "1 file needs both changes", Let Kit merge, Show me both | Has (this branch): the note "main changed while Kit worked. 1 file needs both changes." sits on the row of each lane whose own base moved, with the files, read in the lane's own folder. Show me both draws what the lane's base changed beside what Kit changed. Let Kit merge sends Kit the ask as a message, to the lane of the row it was pressed on when that lane runs as a chat in the project, else to the project's newest chat (none running: a new session with the ask in its box); Kit's steps then ask through their own cards. The developer's folder keeps a note under Kit's dial, read for the project's default base, while Kit works in it (a session with no folder of its own). See [How the main branch moving is read](#how-the-main-branch-moving-is-read) | `src-tauri/src/git_moved.rs`, `code/moved.ts`, `code/MainMoved.tsx`, `code/useMoved.ts`, `code/Lanes.tsx`, `code/askKit.ts` |
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
| Something that keeps running: "Dev server, 42 minutes, port 3000", Stop | Has (this branch): a list under Kit's panel, for the project it shows, of each command a terminal or a chat started that still runs, with the command, how long it has run, its port and Stop (see "What keeps running" below). A lane's commands run in its own folder and are listed with its project. Not on Windows | `running/RunningPanel.tsx`, `src-tauri/src/running.rs` |

## KitCode: the parts

Has: the diff (`DiffView`, which the pane beside a lane draws again), the terminal output and the code block (the timeline's
markdown), and (this branch) the lane row and its mono branch tag, and the pane's Tests box, which draws the command and the
result that was read as the board's Tests box draws a run. Part: the test results are the lane's own tags ("Checked", "Tests
failed", "Not run yet", and "Running tests" in the working tag) with their counts in the line under the row, not the canvas's
one tag ("Checked: 14 tests passed"). Lacks: the trace with tokens and baht per call.

## Needs the owner

- Whether Kit's lanes run as chats in the app, as the canvas's Code board draws them, or only in terminals, as decided
  on 16 November. The dial's asks, the lanes and Rewind to before a turn reach only the first: the + menu starts
  terminals only, so the Lanes band is empty until a chat session exists.

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
- `apps/desktop/src/code/testRun.ts`: a test run read from its words (does a command run tests, and which runner it
  names) and from its output (vitest, jest, node's own runner, pytest, `go test`, `cargo test`, mocha, Playwright Test and
  Python's `unittest`): passed, failed with how many and which, or unknown. See [What each runner's summary is read as](#what-each-runners-summary-is-read-as).
- `apps/desktop/src/code/laneBranch.ts` and `src-tauri/src/lane.rs`: a lane's branch named from its work, planned, and
  made by the shell in a folder of its own (`git worktree add`), with the app's record of each folder it made, the list of
  them, and their removal (see [Where a lane works](#where-a-lane-works)). `code/KeptLanes.tsx` draws the folders kept after
  their sessions closed, with Remove's panel.
- `apps/desktop/src/code/lane.ts`, `laneStore.ts`: what a lane's events showed, the state the owner reads from it, and
  the line under the row. `Lanes.tsx` draws the band in the Kit panel, and gives each row a slot under its line (`below`)
  that the Code page fills with Bring it back's panel and the main-moved note. A lane keeps, beside its last finished
  test run's reading and time, the command that ran it (`run.command`: one line, any key hidden by the app's masker and
  only then cut at 160 characters), and `laneTests` reads the Tests view's facts from the record. `isLaneChat` says which
  chats are a lane's.
- `apps/desktop/src/code/LanePane.tsx`, `changes.ts`, `lanepane.css`: the pane beside a lane's chat (see
  [The pane beside a lane](#the-pane-beside-a-lane)). `LanePaneView` takes everything it shows as props and uses no hooks;
  `LanePane` reads the stores. `changes.ts` reads the files a session changed from the chat's own steps.
  `sessions/SessionView.tsx` (`LaneSplit`) puts the pane beside the chat of a lane.
- `apps/desktop/src/code/BringBack.tsx`: the panel under a Reverted lane's row (see [Bring it back](#bring-it-back-after-a-rewind)).
  `BringBackView` takes everything it shows as props; `BringBack` reads the turn book and runs the call.
- `src-tauri/src/agent_chat.rs`: a command's step hands on the end of what it printed with its `tool.end` (Claude Code
  and Codex), or says `declined` when the person said no and it never ran.
- `apps/desktop/src-tauri/src/git_moved.rs`: the main branch moving, read with the person's own `git`: the folder's
  branch, the branch it started from, and the files each side changed since. It only reads. The shell changes a
  repository in two places only: `lane.rs` makes and removes a lane's folder and its branch, and `turn_files.rs` keeps
  Rewind's snapshots under refs of the app's own and puts a turn's files back.
- `apps/desktop/src/code/moved.ts`: what that means. The files both sides changed, the shell's answer checked before it is
  believed (and, for a lane, that it is about the lane's own branch), one side's diff as the diff view draws it, and the ask
  Let Kit merge sends. `useMoved.ts` reads it again while the page is open, for a lane's own base or the project's default,
  `askKit.ts` sends the ask, `MainMoved.tsx` draws it, and `KitPanel.tsx` puts it on each lane's row.
- `apps/desktop/src/code/preview.ts`: the secrets Kit's changed code reads, by name, and `previewEnv`, the one rule for
  what a preview runs with. `PreviewSample.tsx` draws the Sample row, on the Code page and (without its band, which the chip
  names) under Preview in the pane beside a lane; `needsOfChat` gives one session's.
- The stand-in coding agent (`sessions/host.ts`) answers `/kit install`, `test`, `edit`, `outside`, `key`, `shop`, `merge`,
  `commit` and `deploy`, and the mock host answers what git would say for the canvas's project (`code/mockMoved.ts`), so each
  state can be seen in a browser; `e2e/kit-code.spec.ts` and `e2e/kit-preview-moved.spec.ts` walk them. It also answers
  `/kit pass`, `fail`, `unread` and `slow`: an edit, then a test run whose output comes with the step's end, and
  `e2e/kit-lanes.spec.ts` walks each lane state and `e2e/lane-pane.spec.ts` walks the pane beside a lane (Diff, Preview and
  Tests, the narrow layout, and a Rewind). The mock host makes lanes' folders as the shell does (`laneWorktree`, with
  its records in `window.__manutLanes`), so a browser walks two lanes at once, the chat's note, a closed lane's folder going
  or kept, and Remove's panel: `__manutLaneChanged` and `__manutLaneAhead` say what is in a folder, `__manutLeft` how many of
  the developer's changed files did not come along.

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
| Reverted | the person took the last turn back and no turn has started since | when, and that the files stay as they are (the agent's own rewind), or are back as they were (Rewind, with Bring it back while the shell keeps the files from before it) |
| Checked | the last test run passed, and no file changed after it | "14 tests passed." |
| Tests failed | the last test run failed | "1 of 14 tests failed. Nothing is live." and the failing tests |
| Not confirmed | the last test run could not be read | that the result could not be read, and that nothing is marked as passed |
| Not run yet | no test ran, or a file changed after the last run | nothing, or that the code changed after the last run |

A lane stops being Reverted when a turn starts, and when its files are brought back. After Bring it back it reads by its
tests again, which the rewind cleared, so it says Not run yet, with "You brought the files back at 10:02. The chat stays
where the rewind left it." until the next turn starts.

A test run is a command step whose words run tests (`runsTests`: `pnpm test`, `vitest run`, `cd app && go test ./...`,
`npx playwright test`, `python -m unittest`). The dial's own reading of a command is stricter, since it decides what Kit may
do alone, and is not used for this. When the step ends, its output is read and thrown away: only the counts and the failing
tests' names are kept, with a key masked, and the command that ran it, as one line with a key masked first and the rest cut
at 160 characters (so a cut cannot leave the front of a key too short for the masker to know). The Tests view beside the
lane shows that command; it shows no output, since the lane keeps none. A run is read as passed only when its output says
tests ran, says none failed, and its command did not end in an error. Anything else the parser cannot read is Not confirmed. A failure is read from the output whatever the exit status
says, since `vitest run || true` hides it from the status and not from the output. A file that changes after a run makes
its result old: the lane then says Not run yet, whatever the run said.

The shell hands on the last 8 KiB of a command's output with its step's `tool.end` (`output`), for Claude Code and Codex,
and the whole command line (`command`: the step's start cuts it to 160 characters, and a long folder before `pnpm test`
would hide it). The other agents hand on none, so their test runs are Not confirmed. A step the person refused says
`declined`, and is no test run.

A lane's branch and its own folder are made by the shell (`lane_worktree`, `src-tauri/src/lane.rs`) as the session starts and
before the agent runs: `git worktree add --no-track -b kit/<words> <folder> <commit>` from the commit the developer's folder
is on, with a fixed argument list and a name checked against the one form Kit makes; see [Where a lane works](#where-a-lane-works).
Nothing is pushed, fetched or merged. It refuses a folder that is not a repository, one with no commit, one in the middle of
a rebase, merge, cherry-pick, revert or bisect, one whose index is locked, and a folder inside a repository that the commit
does not hold (`not_committed`); the lane then has no branch of its own, works in the session's folder, and its row says it
works on the folder's branch. Every lane is made from the developer's branch: a second lane started while the first works
gets a folder and a branch of its own, never the first's, and is never stacked on the first's work. If a lane's folder is on
some other branch when its turn ends (Kit switched it), the row shows that branch.

Kit's dial acts on the asks of a coding session that runs as a chat in the app, whose asks arrive as cards: the
canvas's Code board draws Kit's lane that way ("Tell Kit what to change", Kit's note). Since 16 November the Code
page's + menu starts agents in their own terminal only, where an agent's prompts stay inside the terminal, so the dial
does not reach those sessions yet. The Code page shows the dial for every project either way.

Words the shell would expand are never read as what they look like: an unquoted pattern (`*`, `?`, `[`) or brace
list (`{a,b}`, `{1..3}`) makes a command unreadable, so it asks at every level (`lex` in `src/code/command.ts`).

### What each runner's summary is read as

Mocha, Playwright Test and Python's `unittest` are read by the rule the other six are: passed only when the output says tests
ran, says none failed, and the command did not end in an error; anything else is Not confirmed; a failure is read from the
output whatever the exit status says. A command names one of them (`runnerOf`) when it is `mocha` (or `_mocha`), `playwright
test`, or `python -m unittest` (any `python3.x`, with `discover` or not), called directly or through `npx`, `pnpm exec`, `pnpm`
or a path; `playwright install`, `codegen` and `show-report` run no test.

| Runner | What is read | Never a pass |
| --- | --- | --- |
| mocha | the end of the spec reporter (dot, min, progress and list share it): `N passing (time)`, then `N pending` and `N failing` when there are some; each failure's title from the list after them, on one line or on several, joined with `>` | no `passing` line with its time (a line of the others alone is no summary), none passing and none failing, only pending, a run whose command ended in an error |
| Playwright Test | the summary the list, line and dot reporters end with: one line for each kind (`failed`, `interrupted`, `flaky`, `skipped`, `did not run`, `passed (time)`) and the place of each failed test under its line, without the project's name or the file's. A flaky test passed on its retry and counts as passed, as Playwright's own exit status counts it | a test that did not run or was interrupted, an error outside any test, no summary at all (a spec file with a syntax error, "No tests found"), a line that only looks like one (`passed` with no time, `failed` with no test under it) |
| `unittest` | `Ran N tests`, then `OK` or `FAILED (failures=, errors=, skipped=, expected failures=, unexpected successes=)`; each `FAIL:` or `ERROR:` header under a line of `=` names a test. A test that raised or could not be imported counts as failed, an unexpected success is a failure (as unittest's own verdict makes it), a skipped test or an expected failure is neither passed nor failed | `Ran 0 tests` with `OK` (Python before 3.12) or `NO TESTS RAN`, every test skipped, a `Ran` line with no verdict after it |

pnpm's package prefix (`apps/web test: `) is taken off each line of these three first, so the runs of a workspace add up.
Mocha prints its counts before its list of failures, and the shell hands on only the last 8 KiB, so a list long enough to push
the counts out of it leaves the run Not confirmed: never a pass, though it failed. Playwright's summary and unittest's verdict
are the last lines, which the end always holds.

The samples are kept as strings in `testRun.test.ts`. Playwright Test 1.65.1 and Python 3.9.6's unittest were run on this
Mac, in the same small project as the fixtures; Playwright's source was read for the order and the words of its summary.
Mocha is not installed here and was not downloaded: its samples are what its documentation shows for the spec reporter (the
passing sample is word for word, and the failing one is too, less the last lines of its stack trace), and one written by hand
in the form its reporter lists a nested title in. `NO TESTS RAN` is what Python 3.12 and after print for a run of none (that release's runner exits with status 5
for it, which its changelog says); this Mac has 3.9, so that line was not run.

### The pane beside a lane

The canvas's Code board puts a pane beside an open lane: "What to look at", with the chips Diff, Preview and Tests. The desktop
draws it beside the chat of every lane (`isLaneChat`: a coding session that runs as a chat in the app; not the terminal view of
the same session, and not a Hermes folder chat), opened on Diff. It looks at what the session did; it changes nothing and
starts nothing.

- **Where it is.** To the right of the chat while the session view holds both: the chat takes `3 1 440px` and the pane
  `3 1 380px`, as the canvas's `.split` lays out its `.pane` and `.side2`, and the pane is no wider than 640px. When the session
  view is narrower than 820px (a narrow window, or the Plans panel open beside one) the pane goes under the chat, as the canvas's
  side pane goes under the page under 920px: a top rule, at most 45% of the window's height, a scroll of its own, so the chat
  keeps its box for typing. The width is the session view's own (a container query), not the window's, since the side menu and
  the Plans panel take theirs first. `e2e/lane-pane.spec.ts` measures both.
- **Diff.** The files the session changed, each once, with the newest change to each, the file that changed last first
  (`changedFiles`). They are read from the chat's own steps (`Step.diff`, which is what the `tool.diff` events carried), so a
  Rewind to before a turn, which cuts that turn's steps out of the chat, takes its files out of the list and leaves the earlier
  turns' in. Each is drawn by the timeline's own diff view (`DiffView` in `chat/activity/Work.tsx`): the path, the added and
  removed counts of that change, the lines in mono, and `maskSecrets` over every line, as the timeline does. The pane's diff
  has ids of its own (`lane-diff-*`) and does not scroll itself into view, so the timeline's `diff-view` ids are the timeline's
  alone. A file changed twice shows its later change, not both. "Kit has not changed any file yet." is said only while none is listed.
- **Preview.** Says that the preview does not run in the app yet, and under it shows the Sample rows of the secrets Kit's
  changed code reads (`needsOfChat`, drawn by `PreviewSampleView` as on the Code page, without the band that the chip names),
  each with Add, which says the vault comes later. No process is started and no environment is read; a preview that is
  started later has `previewEnv` for what it runs with.
- **Tests.** What the lane keeps (`laneTests`): the last run that finished, in the lane's own words (`resultLine`, the row's
  line too: "14 tests passed.", or "1 of 14 tests failed. Nothing is live." with the failing tests' names, a few, and how
  many more; or Not confirmed with the reason in words: the agent handed on no output, the output has no summary the app can
  read, it says no test ran, it reported errors beside the tests or stopped before every test ran, the command ended in an
  error); when it finished; the command that ran it (`$ pnpm test`: one line, keys hidden, cut at 160 characters); a line when a
  file changed since ("so the result is of older code"), with the result still shown; and any run in progress, with its
  command, above the last result. A rewound turn takes the result away. The board's sample output (`PASS tests/checkout.test.ts`)
  is not drawn: the lane keeps no output, because a test can print anything, so what is shown is what was read.
- **Not drawn.** The board's last line ("A shop owner sees only the note on the left. A developer gets the diff, the preview and
  the tests.") says what the owner's own view is, which the app does not have (the row above says Lacks), so it is not drawn.
- **What it does not know.** A lane's events are of this run: after a restart the lane starts again, and the pane with it.
  After the agent's own rewind of the last message (not Rewind), the chat drops that turn and its files stay where they were,
  so the list holds what the chat still holds. A subagent's own edits come as `subagent` events, not `tool.diff`, and are not
  listed.

The words are in en, ko, ja and zh. `LanePane.test.tsx` draws each view and the chips from props, `changes.test.ts` drives the
chat's own reducer through a rewind, `Work.test.tsx` holds the diff view's ids and its scroll, and `e2e/lane-pane.spec.ts` walks
the pane in a browser.

### Where a lane works

Each lane works in a folder of its own: a git worktree of the developer's repository, on the lane's own branch, made from the
branch the developer's folder is on (`src-tauri/src/lane.rs`, planned in `code/laneBranch.ts`). The lane's chat session runs
its agent there, and everything that reads a lane reads it there: Kit's dial, the test runs, Rewind and Bring it back, the
main-moved note and what keeps running (`workDir` in `code/laneBranch.ts`). Several lanes work at once, none touching
another's files or the developer's folder.

- **Where the folders live.** `~/.manut/lanes/<project>/<words>`: under the app's data folder, never inside the developer's
  folder or its `.git`. `<project>` is the repository folder's name as one plain word, `<words>` the branch's words after
  `kit/` (`kit/promptpay-qr` works in `~/.manut/lanes/web-app/promptpay-qr`), with `-2`, `-3` … when that name is on disk
  already. A session started in a folder inside the repository (`apps/web`) works in the same folder inside its worktree.
  The folders the app makes there are for this account only. git keeps its own note of each worktree in the repository
  (`.git/worktrees/<name>`), as it does for any.
- **Which are the app's.** Beside each folder the app makes, a record of it (`<words>.json`), written as a new file before
  git is asked: the folder, the repository, the developer's folder, the branch, the branch it was made from and the commit.
  Only a folder with such a record, exactly two names below `~/.manut/lanes`, that git still lists as a worktree of the
  recorded repository, is ever removed; a record that names any folder but the one beside it is no record. The app never
  runs `git worktree prune`, and `--force` only ever reaches a folder it made, after the person's yes. Nothing is written
  through a link: a link where a lanes' folder or a record would go is refused or passed over.
- **What comes along.** The committed tree only. The developer's uncommitted changes stay in their folder, and nothing git
  ignores (`node_modules`, build output) is copied or linked: a link would let the lane's install write into the developer's
  folder, and a copy could be of other versions than the lane's lock file says. No hook runs while a folder is made or
  removed (git's `core.hooksPath` points at a folder that is never made), so nothing a project sets up on checkout (an
  install, a generated file) happens by itself. The chat says it as the lane starts: where Kit works, how many of the
  developer's changed files did not come along, and that nothing is installed there yet. The app installs nothing; Kit may,
  and the dial asks first, as for any install.
- **When a folder goes.** When its session is closed, once its agent stopped, if git says nothing in it would be lost (no file
  changed or new; what git ignores goes with it). The branch stays. A folder with changes is kept and listed under the lanes
  as one of Kit's folders kept, for its project, which stays on the Code page for it even when no session is left there.
  Remove opens a panel that says how many changed files go with the folder; ticking Delete the branch too says how many
  commits on the branch are not on its base, or that it could not tell. The press is the yes to exactly those numbers: when
  what is there differs, nothing is done and the panel shows the numbers there are now. A folder removed by hand takes only
  git's note of it and the record with it.
- **While the session is listed** the folder stays, through the agent's end, a Restart and a restart of the app: a lane's
  branch and folder are saved with its session, so Resume and Restart start its agent in its own folder again, never in the
  developer's. A lane whose folder is gone does not start, with the shell's words.
- **Refusals.** Not a repository, no commit, a folder the commit does not hold, the developer in the middle of a rebase,
  merge, cherry-pick, revert or bisect, an index that is locked, every name taken. The session then has no lane of its own
  and works in its folder, as a session in a folder that is not a repository always did. Making a folder may take up to 120
  seconds (a checkout writes every file the project tracks); a folder git could not finish making is taken back, and its
  branch with it while that is still where it was made.
- **Kit's dial.** Inside is the lane's own folder. The level, the kept rules and the allowed folders are the project's, the
  developer's folder's, as Kit's panel shows them. A lane's step in the developer's folder, or in another lane's, is outside:
  stopped, and listed under the project as the lane's ("Kit's lane tried to change a file outside its own folder"). Allow this
  folder on a folder of the developer's lets the lane read there; a change still stays inside the lane's own folder.
- **The test runs.** A run is the lane's when it runs in the lane's folder. A test command whose words send it elsewhere first
  (a `cd` or `pushd` out of it, a package manager's `-C`, `--dir`, `--prefix` or `--cwd`) is not the lane's, and a folder its
  words cannot say (a variable, a pattern, `cd -`, anything after a `popd`) counts as elsewhere: a lane that read the
  developer's run as its own would say its tests passed when nobody ran them on its work.
- **What changes for the developer.** Their folder's branch, index, stash and HEAD never change because of a lane; before,
  `git checkout -b` moved the folder onto each lane's branch as the lane started. Kit's work is on the lane's branch, in the
  lane's folder (Show folder on a kept one; the session's own Show in Finder and Open in Terminal open its folder); it
  reaches the developer's folder only when they merge it or switch to it. While the lane's folder exists, git will not switch
  the developer's folder to the lane's branch (it is checked out in the lane's), and `git worktree list` lists the folder.
  Kit no longer sees the developer's uncommitted changes.
- **Lanes made before this change** (on the developer's folder, with `git checkout -b`) were never saved with their session,
  so after the update such a session comes back with no lane of its own and keeps working where it was, in the developer's
  folder; the app moves nothing. That folder may still be on the old lane's `kit/` branch; switching it back is the
  developer's to do.

### How the main branch moving is read

Before the lanes, Rewind and this note the shell ran no `git`: `git_branch.rs` reads `.git/HEAD` as a file and `tasks.rs`
runs `gh`. Now three places run the person's own `git`: `lane.rs` makes and removes a lane's folder (`git worktree add` and
`remove`, and `git branch -D` when the person asks for the branch to go),
`turn_files.rs` keeps each turn's files under refs of the app's own (see Rewind to before a turn), and `git_moved.rs`
only reads. Which files changed on both sides needs git's own object store, so `session_main_moved` runs `git` through the runner
Tasks already uses for `gh` (`tasks::run_env`: no shell, nothing on stdin, 20 seconds, a cap on the output). Every call only
reads (`symbolic-ref`, `rev-parse`, `merge-base`, `diff`, `ls-files`), none takes the index lock (`GIT_OPTIONAL_LOCKS=0`, so
Kit's own `git commit` never meets it), a path is never a pathspec (`GIT_LITERAL_PATHSPECS=1`), and a branch name from the
page is checked before it reaches an argument. The shell answers with names and commit ids; a diff only when asked, for a
path both sides changed, with keys masked as every CLI answer in `tasks.rs` is.

- The lane is the branch the folder has checked out. The branch it started from is the one the page names (`base`), else the
  one `origin/HEAD` points at, else `main`, else `master` (a local branch before its copy from `origin`). A lane records the
  branch it was made from (`rec.lane.base`, from `startLane` in `sessions/sessions.ts`), and its note names that one.
- Since the two parted, the lane's side is what its commits, the staging area and the work tree changed, with files git does
  not track yet; the other side is what the base changed. A rename counts as a delete and an add, so a file one side moved and
  the other edited needs both changes.
- The note shows when at least one file needs both changes. A base that moved without touching the lane's files shows nothing:
  git merges that by itself.
- **On the lane's row.** Each lane reads git in its own folder, where its branch is checked out, for its own `base`, and shows
  the note under its line. A lane's folder is a worktree of the developer's repository, so the base it reads is the same
  branch the developer's folder sees. The shell answers for the checked-out branch only, so an answer about another branch is
  not this lane's and shows nothing: a lane whose folder has left its branch (the row says so) has no note.
- **Under the dial.** The developer's folder keeps the note under Kit's dial for the project, read for the default base, while
  Kit works in it: a session with no folder of its own (not a repository, an older shell, git refusing, a terminal), or no
  session yet. It stands down while every session of the project works in a lane's folder of its own, since Kit then changes
  nothing in the developer's folder and the note would be about the developer's own work.
- Read when a project opens on the Code page, when the window is looked at again, and once a minute, for each note.

Let Kit merge sends Kit a message, `mergeAsk`: merge the base into the branch, these files changed on both sides, fix any
clash, run the tests, show the result as a diff, and push nothing until told. From a row it goes to that row's lane when it
runs as a chat in the project (`send`); a lane that ended, runs in its own terminal or is gone hands it to the project's newest
session that runs as a chat. Every step Kit takes then arrives as an ask card and is answered through `settleApproval` at the
level the developer chose; `git merge` is a change that rewinding takes back, a push is a push. With no such session, a new
session opens in the project with the ask in its box and nothing starts until the person presses Start (a session in its own
terminal keeps its agent's prompts in the terminal, so the ask is never typed into one). Show me both reads the same base the
note was read for.

### How a preview with no secret is read

A project needs a secret to show something when a line Kit changes reads one from the environment by a name that says what
it is: a shop ID (`PROMPTPAY_SHOP_ID`, `SHOP_ID`, `MERCHANT_ID`) or a key, token, secret or password. Only the name is kept,
never a value, and only code Kit changed (its `tool.diff` events). `previewEnv` is the one rule for what a preview runs with:
a sample for every secret unless the owner added that very secret. Nothing else can put a real one in: not this computer's
environment, not a value found in the code. The sample for a shop ID is all zeros, so no payment can reach an account.

The app has no preview of its own yet, so nothing runs with `previewEnv` today; a preview started by the app must use it. And
nothing saves a secret: Add the shop ID says the vault comes later.

## What keeps running

The Code page lists the commands that this app's own terminals and chats started and that still run, under Kit's
panel and for the project that panel shows (`src/running/`, mounted by `code/KitPanel.tsx`, so picking another project
there switches the list). Each row has the command, how long it has run, the port it listens on if there is one, and
Stop. A line under the list counts what runs in the other projects, so a dev server left in one is never out of sight. The canvas draws it in StatesCodeDev, "Watching it run": a Running tag, "Dev server, 42 minutes, port 3000" and
a Stop button. It draws no question before Stop, so there is none.

**Whose it is.** A command belongs to the project its session started in. A lane's agent works in the lane's own folder, so the
shell names that folder for its commands; the page lists them with the session's project all the same (`projectOf` in
`RunningPanel.tsx`), and a command whose session the page does not know is the folder's the shell names.

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

## Rewind to before a turn

The canvas's StatesCodeDev "Rewind": "The files and the chat go back together. Every turn can be undone as a whole.
Nothing live changes." It works for a coding session that runs as a chat in the app with Claude Code or Codex, the two
agents that can take their chat back to a chosen message.

- **A snapshot when a turn starts.** Before a message that starts a turn goes to the agent, the shell keeps the files of the
  folder the agent works in as they are (`src-tauri/src/turn_files.rs`): a lane's own folder, else the session's. It keeps them again when the turn ends, so a rewind can
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
  turns cannot be rewound. Nor does the home folder, the disk's root or the app's data folder, `~/.manut`, except a lane's own
  folder in it (`~/.manut/lanes/<project>/<words>`), which is a project's checkout like any other. A message waits at most 20 seconds for its turn's files; when keeping them takes longer, the
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

### Bring it back, after a rewind

The canvas's StatesCode "Reverted": "You reverted this turn at 09:40. 3 files are back as they were. Bring it back". Rewind
puts a coding session's files and chat back to before a turn; Bring it back puts the files back as they were just before that
rewind.

- **What is kept.** When the agent took its chat back too (the rewind is then *settled*), the shell keeps the folder's files as
  they were just before the rewind (`back`) and as the rewind left them (`rest`, to tell what changed by hand since), in the same
  store as the turns' snapshots: in a repository a tree under `refs/manut/snapshots/<session>/back`, else a copy in the app's data
  folder, with the lists of files in `~/.manut/turn-snapshots/<session>/` either way. `turn_files_settle` answers `{ back }`, so the
  page knows they are kept. A rewind the agent refused put the files back as they were itself, and keeps nothing.
- **For how long.** Until the next turn starts: the shell drops them as it keeps that turn's files, and the page stops offering them
  as any turn begins, the person's message or one the agent starts itself (that one leaves the shell's copy until the next
  message, which only costs disk). Also until they are brought back, until another rewind goes through (its own files replace
  them; a rewind the agent refuses leaves them alone), and until the session is closed, its agent starts again or the app starts,
  when every snapshot goes.
- **The panel** (`code/BringBack.tsx`, opened by Bring it back on the Reverted line). `turn_files_back_preview` says what would be
  put back (the same `Preview` as Rewind's: each file as `changed`, `back` or `gone`), which of them changed by hand since the
  rewind, files too big to keep now, and whether the branch has new commits since (the files go back, the commits stay). The files
  changed by hand are listed and ticked: each stays as it is unless the person unticks it, as in Rewind. The count says only the
  files that go back, since a ticked file stays, and with every file ticked there is nothing to press. Nothing is written until
  Bring it back is pressed.
- **The chat does not come back.** The panel says so every time, and so does the line the chat gets: "The chat stays where the
  rewind left it." Claude Code's `rewind_conversation` cuts the conversation and Codex's `thread/revert` replaces the thread's
  history with the part before the turn, and neither agent has a message that puts it back. Checked on 24 Nov 2026 in Claude Code
  2.1.331 (every control request its binary handles, among them `rewind_conversation`, `rewind_files`, `fork_conversation` and
  `launch_fork`) and in Codex 0.169.0 (the app-server schema from `codex app-server generate-json-schema --experimental`, among
  its methods `thread/revert`, `thread/fork` and `thread/inject_items`). Claude Code's `restore_if_usage_limited` and
  `restore_if_safeguards_refused` are options of a rewind that put its messages back on their own when the next turn is refused for
  a usage limit or by the API's safeguards: not a way to ask for it afterwards. See Left for later for what was not tried.
- **Putting the files back** (`turn_files_bring_back`). Every file changed since the rewind stays as it is unless the page names it
  (`overwrite`: the files the person saw listed and unticked), so a file changed after the list was read, which they never saw, is
  not lost. The files as they are now are kept first (`undo`), so a bring-back that stops part way puts them back at once and can
  be tried again. It writes in the session's folder only, never through a link (a
  folder that became a link is refused, with Rewind's own words), never moves a branch, and never touches the index, the stash or
  HEAD. When it went through nothing is left to bring back, and the files as they are now are where the next turn starts from, so
  what came back is not read as changed by hand.
- **After it** the chat says how many files came back and that the chat did not ("3 files are back as they were just before the
  rewind. The chat stays where the rewind left it."), and the lane reads by its tests again with its own line (see How a lane is
  read), until the next turn starts.

## Left for later (no owner needed)

- The dial for a session in its own terminal: the shell starting the agent with the permission mode and allowed
  commands the dial gives (Claude Code's `--permission-mode` and `--allowedTools`). That is Rust, and it widens the
  shell's fixed list of arguments, so it wants its own review.
- Bringing the chat back with the files, after a rewind. Neither Claude Code nor Codex has a message for it (see Bring it back).
  Two routes that are not messages were not tried, since each starts something new in the developer's own agent history and so
  wants a decision: Claude Code's CLI has `--resume` with `--fork-session` (whether a resume brings back messages a rewind cut
  was not checked), and Codex has `thread/fork`, which could keep a copy of the thread before each rewind and move the session
  to it, at the cost of a thread more in the developer's own Codex history for every rewind.
- Rewinding a turn sent before the app restarted, or before the agent started again: Claude Code and Codex take back only
  the messages their running process was sent, so those turns are not offered.
- Rewind for a session in its own terminal, or with an agent other than Claude Code and Codex: the first sends no message
  through the app, and the others have no rewind of their own.
- Bringing the developer's uncommitted changes into a new lane's folder, or asking first: today none come along, and the
  chat says how many did not.
- Codex in a lane's folder: a worktree keeps its git data in the developer's repository, outside the folder, so a `git
  commit` that Codex runs inside its workspace sandbox may be refused there and ask to run outside it. Not tried with a real
  Codex.
- A lane's folder from its own row: Remove while the session is listed (today the folder goes, or is kept, when the session
  closes), and a way to bring a kept folder's changes into the developer's (a diff to apply). A kept folder past the newest
  20 of its repository shows no counts until Remove reads them.
- A kept folder whose repository moved on disk: its record names the old place, so it is no longer listed; it stays under
  `~/.manut/lanes` until removed by hand.
- A closed lane's conversation: Claude Code and Codex keep it for the folder they ran in, the lane's own, so the + menu's
  past conversations of the project do not list it. And closing a lane says nothing at that moment about its folder being
  kept: the kept list on the Code page is where it shows.
- Test output from OpenCode and the other ACP agents, and from pi: their steps hand on none, so their runs are Not
  confirmed. More runners than the nine: Cypress, ava, `deno test` and `cargo nextest` are recognised as test runs and always
  Not confirmed, since no reader takes their output yet. A mocha run whose counts the shell's 8 KiB tail cut off is Not
  confirmed (mocha prints its counts before its failures); the shell could hand on more of a long output.
- Open pull request and Ask Kit to fix it on a lane, the effort word and New lane. A pull request needs a push, which
  asks; New lane waits on the owner's call on chats and terminals.
- The pane beside a lane: a way to hide it (it is always there for a lane); a subagent's own edits in its Diff (they come as
  `subagent` events, not `tool.diff`); the files that stay on disk after the agent's own rewind of the last message (its Diff
  holds what the chat holds); the lane's own folder's real changes read from git, so a restart does not start the pane empty;
  the totals of a file's several changes, not only the newest one; Diff, Preview and Tests of a lane from the Code page's row,
  where only the session view has them.
- A lane after a restart keeps its branch and its folder, but what its events showed (its test runs, Reverted) is of the run
  before and starts again.
- The main-moved note for a lane whose folder has left its branch (Kit switched it): the shell reads only the branch the folder
  has checked out, so such a lane shows no note, and the row says it works on another branch now. Reading a named branch is
  Rust (`session_main_moved` would take a `branch` beside `base`).
- The main branch moving: the merge's result shown by the app as a diff after Kit merges (today Kit is asked to show it, and
  asked not to push), and a file both sides changed in the very same way is still counted as needing both changes.
- What keeps running, inside an open session: the list is on the Code page, for the project Kit's panel shows, and an
  open session does not show its own commands. Also: Windows has no reader, so the page draws nothing there; a command
  that left its parent for good (a daemon) is no longer found; a long-lived `sh -c` that an agent keeps for its own use
  would be listed as a command; and so might a helper a shell's startup file leaves running (not seen yet).
- The preview itself: the project run, in the pane beside the lane where its Preview view now says the app has none, started
  with `previewEnv`, so a secret it reads is a sample. Reading what a project needs from its `.env.example` as well as from
  Kit's changes.
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
