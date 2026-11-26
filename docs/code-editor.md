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
| Lanes: a band with New lane, a row per lane with its title, "Kit, Careful" and a status tag | Part (this branch): the Kit panel opens with a Lanes band with a quiet New lane link (drawn even while the project has no lane), a row for each coding session that runs as a chat, with its title, "Kit · Claude Code", its branch and a state tag. Terminals stay in their folder groups below. Under the lanes, Kit's folders kept: a lane's folder that outlived its session, with Show folder and Remove. A lane is started from the + menu's Chat with Kit (item 66), or from New lane in the band, which opens that menu (item 68; see [Starting a lane](#starting-a-lane)). No effort word | `code/Lanes.tsx`, `code/KeptLanes.tsx`, `code/KitPanel.tsx`, `sessions/SessionsSection.tsx` (`ChatWay`) |
| The lane's own branch (`kit/promptpay-qr`): "Kit works on a separate branch. Nothing is live." | Has (this branch): a chat session gets a branch of its own as it starts, named from its first message and made from the branch the developer's folder is on, checked out in a folder of its own (a git worktree under `~/.manut/lanes`), where its agent works. Several lanes work at once, none touching another's files or the developer's folder, whose branch, index, stash and HEAD never change because of a lane. The row and the composer's foot show the branch. Nothing is pushed or merged but through the asks of [Source control](#source-control). See [Where a lane works](#where-a-lane-works) | `code/laneBranch.ts`, `src-tauri/src/lane.rs`, `sessions/sessions.ts` (`startLane`) |
| "Checked: 14 tests passed" | Has (this branch): read from the test run's output (vitest, jest, node's own runner, pytest, `go test`, `cargo test`, mocha, Playwright Test and Python's `unittest`). A run that cannot be read is Not confirmed, never Checked | `code/testRun.ts`, `code/lane.ts` |
| Revert this turn | Has: Rewind, on the line under the box beside the branch, puts back the files and the chat of a kept turn; the newest is picked first. Claude Code and Codex only. The agent's own Edit on the last message still takes back the chat only, and then the lane says the files stay as they are | `sessions/RewindPanel.tsx`, `sessions/rewind.ts`, `src-tauri/src/turn_files.rs`, `code/lane.ts` |
| Open pull request | Has (item 75): Put up for review under a lane's row and in its pane pushes the lane's branch and opens its pull request through `gh` or `glab`, after one ask that names the repository, branch, base, title and body exactly as sent, settled once; an open one then offers Merge, asked with its method and exact message. A lane whose branch has an open pull request shows "Pull request #12 (Open)" quietly under its title, and pressing it opens Tasks on that repository with the request selected (item 76, [Pinned, snoozed, settled and archived](#pinned-snoozed-settled-and-archived)). See [Source control](#source-control) | `code/Review.tsx`, `code/reviewAsk.ts`, `src-tauri/src/review.rs`, `tasks/pulls.ts`, `code/Lanes.tsx` |
| The request, "Edited 3 files and ran 14 tests", Kit's note, the changed files with their counts | Part: the session's timeline shows each step and a file edit's diff, and (this branch) the pane beside a lane lists the changed files with their counts. No line that counts the files and the tests together | `chat/activity/Work.tsx` (`DiffView`), `code/LanePane.tsx` |
| Tell Kit what to change, add a file, the Code chip | Has: the session's composer (item 80, the same box as Buddy's), in two rows as the canvas draws it: the text, then a + for Add context (Files; Folder, named in the message by its path and never copied; Actions and skills, the agent's `/` menu, also over text already typed), the agent, the model with its effort, the approval level, the microphone and voice mode (item 81, the Mac app: speak the message, or talk with Kit and hear the answer, the asks still on their cards; `docs/voice.md`) and Send. No Mention: a coding agent knows no team | `sessions/SessionView.tsx`, `chat/box/`, `chat/parts/Attach.tsx`, `chat/parts/Composer.tsx`, `voice/` |
| "Your Claude Code plan" in the composer | Part: a session runs on the developer's own sign-in; the box names the model (moved there from the header) and its effort, not the plan. Since item 132 (GoSpark's flow) the model chip opens the effort card: the level large by GoSpark's words (High, Extra High, Max), the model under it, which opens the agent's model list as the card's second view (Back, or a pick, returns), Reset to the default level, and a slider with one stop for each level the agent reported, moved by a drag (which sends only the level it lets go on), a click or the arrow, Home and End keys. At the top level the title and the track take the provider's colour from its mark (Claude Code's terracotta; Codex in the ink). A Claude Code chat's card adds "Ultrathink this message", which puts a visible `Ultrathink:` line at the top of the draft and takes it out again; a word typed by hand or a slash command locks it. Nothing new reaches the agent: a level goes by the same effort input as before. No fast mode (no agent reports one) and no Ultracode | `sessions/SessionView.tsx` (`SessionModel`), `chat/box/ModelMenu.tsx`, `chat/box/EffortCard.tsx`, `chat/box/effort.ts`, `chat/box/ultrathink.ts`, `docs/decisions/132-effort-card.md` |
| Diff, Preview and Tests beside the lane | Part (this branch): the chat of a lane has a pane beside it, "What to look at", with the chips Diff, Preview and Tests, Diff first; it goes under the chat when the column is too narrow for both. Diff: each file that really differs in the lane's own folder from where the lane started, read from git (so it holds after a restart and shows a subagent's edits), with the added and removed counts, drawn as the timeline draws a change; from the chat's own events where the shell cannot read. Tests: the last finished run's result as the lane read it, when it finished, the command that ran it, whether a file changed since, and any run in progress; none of the run's output, which the lane never kept. Preview (this branch): the lane's project run with its own dev server in the lane's own folder: the command named first (`$ pnpm run dev`) with Start, then Running at its address with Open in browser and Stop, Stopped, Ended with its exit code and its last lines, or Could not start with why; the Sample rows under it. While it runs at an address of this computer, its page is drawn in a frame that fills the view, as the board draws the page in a box, with Reload and Open in browser above it (this branch). See [The pane beside a lane](#the-pane-beside-a-lane), [The preview of a lane](#the-preview-of-a-lane) and [The page in the pane](#the-page-in-the-pane) | `code/LanePane.tsx`, `code/LanePreview.tsx`, `code/previewFrame.ts`, `code/previewStore.ts`, `src-tauri/src/preview.rs`, `code/changes.ts`, `code/laneFolder.ts`, `src-tauri/src/lane_diff.rs`, `code/lanepane.css`, `sessions/SessionView.tsx` (`LaneSplit`) |
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
| How much Kit does alone: Asks every time, Edits alone, Edits and safe commands, Everything in this project. "Going live always asks, at every level." | Has (this branch): the dial on the Code page, per project, and the asks it settles by itself. The chat box's approval menu (item 80) offers the same dial for the session's project under the agent's own presets (Ask, Plan, Accept edits for Claude Code), one setting in two places; an agent with no presets shows the dial's level on the button | `packages/member-grants/src/kit.ts`, `code/KitPanel.tsx`, `code/kitAsks.ts`, `sessions/SessionView.tsx` (`SessionApproval`) |
| Outside the project: blocked and shown, with Allow this folder | Has (this branch): denied as it is asked, listed on the Code page, and Allow this folder lets Kit read there | `code/kitAsks.ts`, `code/KitPanel.tsx`, `code/project.ts` |

### Secrets

| State | Desktop | Where |
| --- | --- | --- |
| Kit needs a secret: typed once into the vault, Kit uses it without seeing it | Lacks on the desktop. The API's vault keeps the shop's sign-ins; the desktop keeps only its own session in the keychain (Owner: real secrets) | `apps/api/src/sign-in-vault.ts`, `src-tauri/src/api_link.rs` |
| A secret found in the code: moved out, never committed | Part (this branch): a key in Kit's changes is found and named, a commit or push then asks at every level, and no diff shows it. Since item 117 a commit or a push the dial would let go alone first reads what it saves (the lane's own diff), so a key a command wrote makes it ask too, as does a diff that could not be read. Moving it to a vault lacks | `code/secrets.ts`, `code/kitAsks.ts`, `chat/activity/Work.tsx` |
| No secret in the preview: a sample until the owner adds one | Part (this branch): the state and its words. A secret Kit's changed code reads by name (`process.env.PROMPTPAY_SHOP_ID`) shows as Sample, "The preview has no shop ID yet, so the QR code is a sample", with Add the shop ID, which says the vault comes later. The rule for what a preview runs with (a sample unless the owner added that secret) is `previewEnv`, and the preview of a lane runs with it (this branch), with a sample too for each secret the lane folder's `.env.example` names. Nothing adds a secret: the owner has not said where a developer's secrets live (Owner: real secrets) | `code/preview.ts`, `code/previewRun.ts` (`previewSecrets`), `code/PreviewSample.tsx` |

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
| Your plan needs a sign-in | Part: a session that is not signed in says so and points to Settings › Providers, where Accounts now is (Owner: a real sign-in to try it) | `sessions/sessions.ts` (`signedOutSaid`) |
| Your own MCP servers and skills, wherever the agent runs | Has (item 72): see [MCP servers and skills](#mcp-servers-and-skills); an added Claude Code account does not get the servers added with `claude mcp add` | `src-tauri/src/lane_config.rs`, `accounts.rs` (`share`), `acp_mcp.rs`, `settings/mcp/McpSkillsPage.tsx` |

### Watching it run

| State | Desktop | Where |
| --- | --- | --- |
| The terminal: Kit runs commands here, and you can type too | Has | `sessions/term/`, `terminal/Panel.tsx` |
| Something that keeps running: "Dev server, 42 minutes, port 3000", Stop | Has (this branch): a list under Kit's panel, for the project it shows, of each command a terminal or a chat started that still runs, and each lane's preview (tagged Preview), with the command, how long it has run, its port and Stop (see "What keeps running" below). A lane's commands run in its own folder and are listed with its project. Not on Windows | `running/RunningPanel.tsx`, `src-tauri/src/running.rs` |

## KitCode: the parts

Has: the diff (`DiffView`, which the pane beside a lane draws again), the terminal output and the code block (the timeline's
markdown), and (this branch) the lane row and its mono branch tag, and the pane's Tests box, which draws the command and the
result that was read as the board's Tests box draws a run. Part: the test results are the lane's own tags ("Checked", "Tests
failed", "Not run yet", and "Running tests" in the working tag) with their counts in the line under the row, not the canvas's
one tag ("Checked: 14 tests passed"). Lacks: the trace with tokens and baht per call.

## Needs the owner

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
- `apps/desktop/src/code/secrets.ts`: keys in Kit's changes, counted with the app's one masker (`src/lib/secrets.ts`). Since
  item 113 the masker also knows private key blocks, provider-prefixed keys, JSON web tokens, credentials in HTTP headers,
  `password:` and `"password":` values, the password in `scheme://user:pass@host`, quoted `KEY="..."` and `--password value`,
  so a change holding any of them makes a commit or a push ask too. Item 117 added `name = value` with blanks round the
  sign (`~/.aws/credentials`), `DB_PASS`, `MYSQL_PWD`, `SMTP_PASS`, `APP_KEY`, `SECRET_KEY_BASE`, a vendor's `_KEY=`, a JSON
  `"key"`, `.netrc`'s password, `curl -u`, `mysql -p`, Slack's and Discord's webhook addresses, and the Resend, Replicate,
  Perplexity, xAI, Docker, age, Google OAuth client, Slack refresh, Atlassian, Postman, Netlify and Mapbox prefixes, each in
  the shared table beside an ordinary line it leaves alone. Ordinary text stays as it is, so it is no key in the changes
  either: a CSS class or a name that starts with `sk-` (`sk-folding-cube`, `sk-learn-pipeline`), a value that is a
  reference (`${DB_PASSWORD}`, `` `Bearer ${token}` ``), and a word that says there is none (`Token: none`, `null`, `false`).
  Since item 117 the count never goes down (a key taken
  out again may already be in a commit), and a commit or a push the dial would otherwise let go alone first reads what it
  saves: the lane's own diff, from the shell's read-only `lane_diff` (bounded, `--no-ext-diff --no-textconv`, no clean filter,
  each file's diff masked by the shell's twin). A file an added line of which holds a key makes the step ask, whoever wrote it,
  and so does a file it could not read whole (binary, too large, past its budget or its list) or a read that failed or took
  more than five seconds. That read only reaches a folder the app made, so a commit or a push from a session in the
  developer's own folder always asks. Since item 120 three routes that read does not see ask too: a line that writes files
  beside its commit or push (`cp .env notes.txt && git add notes.txt && git commit …`: the read is made before the line
  runs; staging what is there, `git rm`, `git mv`, a read or a check beside it are fine, `git add -f` is not), a message or
  a body read from a file (`git commit -F`, `--file`, `-t`, `--template`, `gh pr create -F`, `--body-file`, `-T`), and a
  push (or `gh pr create`) whose commits hold a key the folder no longer does. For a push the shell also reads every commit
  on the lane's branch that no remote-tracking branch holds (`git log` with `--no-ext-diff --no-textconv`, a merge against
  its first parent, at most 200 commits and 4 MB, within the same budget): a key in an added line, a file's new name or a
  message makes it ask and is named on the card (a message by its commit's short id); more commits, a binary change, or a
  read not made in time asks too. A commit is not held up by the history: it sends nothing. Since item 117 the masker has two forms: `maskSecrets`
  for text that never runs, and `maskCommand` for what an ask's card shows, which masks a key and never a substitution, a
  pipe, a second command or a command's own operand (a token-shaped word is a key only as a whole word with a key's
  shape); a private key block keeps its BEGIN and END lines around one masked line only inside a quoted string or a heredoc's
  body that a writer (`cat`, `tee`, `echo`, `printf`) leading the command only writes out, and its body holds only base64
  and PEM header lines; anywhere else it is shown whole. Since item 121 a masked value also stops at a blank, a quote, `#`
  and a glob character, and the masked command must split into the command's own shell words or it is shown as it is with
  a note that it may hold a key, and every character that does not show, or that reorders what does, is a visible mark
  such as `⟨U+202E⟩`, with a note that the command holds hidden characters (docs/remote-access.md, "An approval shows
  what runs"). The card shows a command whole, its line breaks kept, scrolling in its block.
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
- `apps/desktop/src/sessions/SessionsSection.tsx` (`ChatWay`), `sessions/agents.ts` (`chatAgents`) and `sessions/sessions.ts`
  (`draftChat`): the + menu's Chat with Kit, which starts a lane (see [Starting a lane](#starting-a-lane)); `sessions/signedOut.ts`: which
  agents the menu marks Not signed in; `sessions/newMenu.ts` (`NewMenuStart`): how New lane opens the menu.
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
  repository in four places only: `lane.rs` makes and removes a lane's folder and its branch, `turn_files.rs` keeps
  Rewind's snapshots under refs of the app's own and puts a turn's files back, `git_pull.rs` moves a clean default branch
  forward to its remote's commit (Automatically pull), and `review.rs` pushes a lane's branch and opens or merges its pull
  request, each only after a settled ask (see [Source control](#source-control)).
- `apps/desktop/src/code/moved.ts`: what that means. The files both sides changed, the shell's answer checked before it is
  believed (and, for a lane, that it is about the lane's own branch), one side's diff as the diff view draws it, and the ask
  Let Kit merge sends. `useMoved.ts` reads it again while the page is open, for a lane's own base or the project's default,
  `askKit.ts` sends the ask, `MainMoved.tsx` draws it, and `KitPanel.tsx` puts it on each lane's row.
- `apps/desktop/src/code/preview.ts`: the secrets Kit's changed code reads, by name, and `previewEnv`, the one rule for
  what a preview runs with. `PreviewSample.tsx` draws the Sample row, on the Code page and (without its band, which the chip
  names) under Preview in the pane beside a lane; `needsOfChat` gives one session's.
- The preview of a lane (see [The preview of a lane](#the-preview-of-a-lane)): `src-tauri/src/preview.rs` reads a lane's folder,
  runs the chosen command there with an environment that starts empty, hands its lines on and stops its process group;
  `code/previewRun.ts` chooses the command (`@manut/preview-command`), says what it runs with (`previewSecrets`) and what each
  thing the shell says makes of a run; `code/previewStore.ts` keeps each lane's; `code/previewHost.ts` is the shell, or a fake run
  in a plain browser; `code/LanePreview.tsx` draws it under the Preview chip. `e2e/preview-run.spec.ts` walks it.
- The page in the pane (see [The page in the pane](#the-page-in-the-pane)): `code/previewFrame.ts` says which address the frame
  may show and why it shows none, and holds its sandbox; `code/LanePreview.tsx` draws the frame; tauri.conf.json's `frame-src`
  bounds every frame; `src-tauri/src/preview.rs` (`app_window_may_load`) is the app window's navigation hook (lib.rs
  `app_window_guard`). `e2e/preview-frame.spec.ts` and `e2e/preview-frame-webkit.spec.ts` walk it.
- Source control (item 75, see [Source control](#source-control)): `src-tauri/src/source_tools.rs` reads git, gh and glab for
  `settings/SourceControlPage.tsx`; `src-tauri/src/git_pull.rs` and `code/AutoPull.tsx` pull a clean default branch;
  `src-tauri/src/review.rs` writes down and runs the asks that push and open a pull request or merge one, `code/reviewAsk.ts` settles
  them through approval-core and `code/Review.tsx` draws them; `src-tauri/src/credits.rs` takes agent credit lines out of a merge's
  message, from the list in `src/lib/agentCredits.json`; `src/lib/sourceControl.ts` keeps the page's choices.
- Workflows (item 77b, see [Workflows](#workflows)): `src-tauri/src/workflows.rs` reads `~/.manut/workflows/`; `src/workflows/` checks each
  file, runs it as a lane step by step (`sessions.ts` `startWorkflowLane`), keeps its history and its clock, and draws Settings ›
  Workflows; the palette's "Run workflow" presses its Run now. Item 91: a run starts only from the exact text the person allowed
  (`workflows/allow.ts`), in the top folder of a git repository the shell checked (`workflows.rs` `project`), in a lane of its own.
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

An ask's title and command are for the person: since item 117 the command is whole, its line breaks kept, and the card
masks only its keys (`maskCommand`). The dial does not decide from those words, which the masker has been over, so the
shell also names what the agent asked, from the agent's own message, and the dial reads that:

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

#### What a read or a check never is (item 88)

A read or a check goes alone at every level, so `src/code/command.ts` calls nothing one that writes a file, runs another
program or reaches the network. What it does not understand is `unknown`, and asks:

- **Every form of an option.** An option is recognised as its program reads it: alone, with `=value`, with its value
  joined (`-ofile`), bundled after other short options (`-fsSLo`), or as any start of a long option's name (git and GNU
  getopt take one). A path joined to a short option, or after `=` in any word, is checked against the project like any
  other. An option that makes a step looser (a dry run, a list) counts only written in full and never beside a `--no-`
  word that takes it back.
- **Only known options for some.** git fetch, git config, git branch and git tag lists, make, just, task and the
  package managers' own options are read from a list; any other option, and a `NAME=value` after make or just, asks.
- **Checks.** A test run, a lint or a type check is no check with an option that loads a program, names a settings file
  not named as one, writes a report or snapshot, deletes a folder (`pytest --basetemp`) or sends output to a service; the
  same holds for words a package manager hands to a script (`pnpm test --…`).
- **The network is not a read.** curl, wget (only `curl --version` and `--help` stay reads), `gh api`, gh pointed at
  another host, a fetch, pull, clone or push to an address rather than a remote's name, a registry named on the command
  line and a package named by its address all ask, as anything that sends does. `git fetch` from a remote the project
  has stays a read.
- **What cannot be read in advance.** xargs (the words it adds are not known), awk with any redirect or pipe after a
  print, gawk's `@`, a program that sets ARGV or reads ENVIRON, unpacking an archive, applying a patch, making a link
  (a later change to its path lands where it leads), `git clean -x`, zsh's `=word` and `>!`, and `>& file` read as the
  file it is.

#### What the third review added (item 112)

- **Every action, not the first.** A find is read word by word from a list of its known tests and options: each command
  it runs (every `-exec`, `-execdir`, `-ok`, `-okdir`) is read as a command of its own, `-delete`, `-fprint`, `-fls` and
  any test or action the list does not know make it no read, and a file it compares with (`-newer`, `-samefile`) is
  checked against the project. A subcommand is read only where its program looks for it: `git stash -m list` is a push
  of the stash, and `docker compose` with its own options before the command asks.
- **A runner's own options.** npx (and `npm exec`) is read only with `-y`, `--yes`, `--no`, `-q`, `--quiet`, `-s` or
  `--silent` before the tool: npm reads any other as one of its settings (`--node-options`, `--registry`). `pnpm exec`,
  `yarn exec`, `bun x` and bunx with any option before the tool ask, and pnpx is `pnpm dlx`, which asks. node itself,
  `NODE_OPTIONS` and npm's `npm_config_*` in front of a command already asked; a test runner told to hand node options to
  its workers (mocha's `-n`, ava's `--node-arguments`, vitest's `execArgv`) or to load a module (vitest's `--pool`,
  `--diff`, `--workspace`, a custom coverage provider; jest's `--runner`) as a file is no check.
- **zsh's expansions.** Codex (`zsh -lc`) and Claude Code run commands in zsh on a Mac, and zsh expands more after a `$`
  than bash: `$=X` splits a variable into words, `$~X` reads it as a pattern, and `$^X`, `$+X`, `${(z)X}` and `${(e)X}`
  do more. An unquoted `$` followed by anything but a blank or the line's end is not read in advance, so a variable set
  earlier in the line never reaches a later word unseen. `=(…)` and `<(…)` already asked. printf with an option
  (`printf -v PATH …` sets a variable, PATH among them, for every later word) asks; any other builtin that sets one
  (`read`, `declare`, `typeset`, `print -v`) already did, as did an assignment to anything but a harmless variable.
- **A reading program's own output file.** uniq and xxd each have their own options that take a value, so a second file
  (the one they write) is always seen; yq's `--split-exp`, terraform's `plan -out` and `-generate-config-out`, helm's
  `--output-dir`, pulumi's `preview --save-plan`, kubectl's `--cache-dir` and `--profile`, lsof's device cache and
  `docker compose config -o` are changes, and helm's `--post-renderer` asks. `cdk synth` and `cdk diff` run the project's
  app and write `cdk.out`, so they are a build, not a read. Each program the reader calls a read was checked against its
  own manual for an option or a file it writes; diff, cmp, comm, cut, tr, nl, od, hexdump, strings, column, fold, rev, wc,
  stat, du, df, ls, file (but `-C`), head, tail and cat have none.
- **A file read that the words did not show as one.** With `-f` jq takes the first file as its filter wherever `-f`
  stands, so no word is a filter then and every file is checked; a jq filter that imports or includes a module asks, and
  `-L`'s folder is checked. git grep's `-f` file is checked, and so is the file `git commit -F`, `--file` or `-t` takes a
  message from, which a kept "git commit" rule would otherwise carry out with the next push. A list of files read from a
  file (`--files0-from`, `--files-from`, tar's `-T`, zip's `-@`) asks, since the files are named nowhere, and `@file`
  that names a path from a root, the home folder or a folder above is checked as that path.
- **Another computer, for every program.** A word that holds an address (`scheme://`, but a `file://` link) makes any
  step below `unknown` a send, a change and an install included (`pnpm add https://…`, `docker build https://…`); words
  read as text (a message, a pattern, a script) do not count, and git and gh read their own addresses as before. A read
  or a check with an option that names a server (`--server`, `--api`, `--repo`, `--registry`, `--endpoint`, `--url`,
  `--host`, `--remote`, `--proxy`, or a name ending in one, such as `--index-url`) is a send too, and so are turbo's
  `--token` and `--team`, kubectl's `-s`, helm's `--kube-apiserver` and `go list -m` asking for versions, updates or
  retractions. A kubeconfig or kuberc named on the line asks (it can name a program kubectl runs), and `turbo.json`,
  which can name where turbo sends its cache, is a file a change to which always asks.

#### Secrets a read prints from outside the project (item 116)

Some reads print a key kept outside the project without naming a path. They are read as `printenv` is, and ask:
`kubectl get` or `describe` of a secret (`secret`, `secrets`, `secret/name`, in a list too), `terraform output` (and
`tofu output`), `docker inspect` (and `container inspect`, `image inspect`), `docker compose config` but for its
`--services`, `--volumes`, `--profiles`, `--images` and `--networks` listings, `git config --list`, `--get-regexp`,
`--get-urlmatch` and a setting whose name says it holds a key, from every scope but the project's own (`--local`,
`--worktree`, `--file`), `git var -l`, `ps` with `-E` or BSD's `e` (`ps eww`, `ps aeux`; `-e` alone is every process),
yq's `load` and its kinds and its `env` read after `eval` or `eval-all` too, and a package manager's `config` but a
`get` of a setting whose name says nothing of a key (a listing, a `get` of a token, any option after `config`). Each
plain twin (`kubectl get pods`, `terraform plan`, `docker ps`, `git config --get user.name`, `ps aux`) stays a read.
`pnpm config list` and a bare `yarn config` now ask.

Since item 120 these ask too: git's own `git config get` with `--regexp` or `--url` (a listing; its other options are read
from its own list), `kubectl get` or `describe` with `-f`, `--filename`, `-k`, `--kustomize` or `--raw` (a file can name a
Secret), yq's `load` and `env` and jq's `$ENV` and `env` wherever they stand (after `-o json`, joined to
`--expression=`), yq's `eval(…)`, which builds an expression as it runs, a jq or yq filter read from a file (`-f`,
`--from-file`), `helm status` with any output but the table, `terraform show -json` (and tofu's), and
`pulumi … --show-secrets`. So `kubectl get -f k8s/web.yaml` and `jq --from-file=filter.jq data.json`, plain before, ask.

#### Tags, and a branch moved back (item 120)

A push of a tag goes live, as a release starts from one: `--tags`, `--follow-tags`, `refs/tags/…`, `tags/…`, a name that
reads as a version (`v2`, `v2.0.0`, `1.4.2`, `desktop-v0.1.1`), and a tag the line or an earlier step of the chat made
(`git tag nightly`, then `git push origin nightly`). A tag of another name made before the chat is not known by its name.
`git branch -f`, `-M` and `-C`, `git checkout -B`, `git switch -C` (`--force-create`), `git worktree add -B` or `--force`,
and `git update-ref` move a branch's tip as `reset --hard` does, so they read as a discard; `-B`, `-C`, `-M` and
`--force-create` are harsher options a kept rule never covers. A commit named from another before `--` (`HEAD~5`,
`main^`, `@~2`) is no path, so it is no longer read as a Windows short file name: `git rebase -i HEAD~3`,
`git reset HEAD~1`, `git revert HEAD~1`, `git cherry-pick main~2`, `git checkout HEAD~1` and the like read as the change
they are instead of asking.

#### git in another folder, and a program named by a path (item 116)

- **git reads only the project's own folder.** `git -C` naming any folder but the project's (one folder after another
  for several), and `--git-dir` or `--work-tree`, ask: a folder of a few plain files git takes for a repository can
  name a program git runs on a read. Every agent the app starts also runs git with `safe.bareRepository=explicit`
  (`bare_explicit` in `src-tauri/src/providers.rs`, through `GIT_CONFIG_COUNT`, after any the person set), so its git
  refuses such a folder found by `-C` or by its own folder. For a person this means a bare repository works in an
  agent's session only when named with `--git-dir` or `GIT_DIR`; a normal repository, a lane's worktree and `.git`
  itself work as before.
- **A tool by its path.** A program named by a path is read by where the path leads once `..` is taken out: only
  `node_modules/.bin/<name>` in the project or a folder of it is the tool of that name. Anything else
  (`node_modules/.bin/../../scripts/test`, `/tmp/x/node_modules/.bin/vitest`, `../node_modules/.bin/vitest`) is a
  program nobody has read, and asks.

#### What a kept rule covers (item 116)

"Always allow in this project" keeps a command's first words and, since item 116, the step it was kept for (a change,
an install, a delete or a push). A later command is covered only when it begins with those words, is that very step,
and carries no option after them that makes it harsher: `--force`, `--delete`, `--hard`, `--clear`, `--recursive`,
`--mirror`, `--prune`, `--discard-changes`, and git's `-f`, `-d`, `-D` and `-r` or a package manager's `-f` and `-r`,
in a bundle too. So a rule kept from `git push origin kit/x` covers another push of a branch, never `git push --force`
or `git push --delete`, and one kept from `git branch kit/new` never covers `git branch -D`. A rule saved before item
116 names no step; it covers only the step its own words mean when read alone (`git push` a push of a branch of Kit's
own, `git branch kit/new` a change). Kit's card offers a rule again for a harsher command, since the kept one does not
cover it.

#### A check's options, from a list (item 116)

Four reviews each found an option a deny-list did not know that makes a check or a read write a file, run a program the
line names, open a debugger on an address, or fetch and install. So a check is now read from a list of the options its
program is known to take harmlessly (`KNOWN` in `src/code/command.ts`), and any other option makes the line ask:

- **Every checker.** vitest, jest, mocha, playwright, tsc and vue-tsc, eslint, prettier, pytest, mypy, ruff, pylint,
  black, isort, shellcheck, actionlint, `go test` and `go vet`, `cargo test`, `check`, `bench` and `clippy`. Each list
  was read from the program's own `--help` on this Mac or, for one not installed here, from its own documentation
  (jest, eslint, prettier, mocha, pylint, go test). A checker whose options were not read (ava, tap, pyright, flake8,
  knip, depcheck, cspell, stylelint, markdownlint, hadolint, cypress, biome, a framework's `lint`, nx,
  `python -m unittest`) takes none: with any option it asks. An option that fixes or updates (`--fix`, `--fix-only`,
  `--add-noqa`, `-u`) makes the line the change it is.
- **Subcommands too.** `ruff` is a check only as `check` or `format`, `biome` as `check`, `lint`, `format` or `ci`, and
  `vitest init` is none.
- **Words handed on.** What a package manager hands to a test script (`pnpm test -- …`, `bun test …`) and what turbo
  hands to a task after `--` are read from a short list harmless in every common runner. turbo's own options are
  `--filter` alone.
- **pip and uv.** `pip list`, `show`, `freeze` and `check`, and the same under `uv pip`, are reads only with their own
  listed options: `--log` appends to a file and `--python` names a program to run.
- **A guarded file as an option's value.** On any read or check, an option's value that is a file a change to which
  always asks (`--log CLAUDE.md`, `--x=.husky/pre-commit`) asks; one that only leaves something out
  (`--exclude-dir=.git`) does not, and a file named as an operand (`cat package.json`) stays a read.
- **An option's value never hides the next option (item 120).** In every allow-list (the checkers', pip's and uv's, a
  package manager's own, make's, just's and task's, git fetch's, git branch's and git config's) an option that takes a
  value never takes a next word that starts with `-`: vitest's `--changed`, cargo's `--test`, jest's `--bail` and make's
  `--jobs` take their value only joined, so `vitest run --changed --inspect=0.0.0.0:9229` ran a debugger on every network
  while it read as the tests. Options whose value is optional are listed as such from each program's help (vitest 3.2.7's
  `--changed`, cargo's `-p`, `--bin`, `--example`, `--test`, `--bench` and `--target`, jest's `--bail`, make's `-j` and
  `-l`, which take a number only). A program whose value is required takes such a word or refuses to start, so reading
  it as an option only asks more. As a backstop, `--inspect`, `--inspect-brk`, `--inspect-port`, `--inspect-wait`,
  `--debug-port` and `--debug-brk` make any check ask, in any runner and in what a script is handed.

None of the 221 everyday commands changed. Not yet on a list: the reads that item 112 checked against their manuals
(cat, ls, head, diff and the like), git's, gh's, docker's, kubectl's, terraform's and helm's reads, the words
`cargo test` hands its test binary after `--`, and jq and yq; their deny-lists and the option-value check above still
apply.

#### The folder a session's commands run in (item 116)

An ask names the folder a command runs in as the session's own, but an agent's shell may keep a `cd` for its next
command. Claude Code no longer does (it starts with `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`, see the open notes
below), but the dial does not rely on any agent:

- **A `cd` asks when it goes somewhere that matters.** A `cd` into a folder a change to which always asks (`.git`,
  `.claude`, `.husky`, `.github`, `.vscode` and the rest) asks, as one outside the project is stopped. One whose folder
  cannot be known asks too: `cd -`, a folder from the stack (`cd +1`, `cd -2`), zsh's two-word form, `~user`, `pushd`,
  `popd`, `source`, `.` and `eval`.
- **Each session's folders are carried.** The app keeps, for each session, every folder its shell may be in after the
  commands it has asked about, and reads each new command from the session's folder and from each of those, the
  strictest reading speaking. A command the dial stopped never ran and moves nothing; one the person may still allow is
  counted as if it ran. The list only grows, since a command may fail and an agent may then stay where it was; a command
  that is only `cd` to the project's folder, written in full, sets it back to that folder.
- **Every way through a line.** Within one line, a `cd` may fail: `;` and a line break run the next command either way,
  `&&` only after a `cd` that went, `||` only after one that did not. A `cd` in a pipeline or in the background moves
  nothing, but both folders are kept. So `cd x; cat ../secret` is read from the project's folder too.
- **A folder that cannot be known.** After a command that leaves the folder unknown (the forms above, a subshell or a
  brace group that holds a `cd`, or a shell command the dial could not read at all), every later command of the session
  asks, except one that names no file (`pwd`, `echo`, `date` and the like) and a `cd` to a folder written in full, until
  a command that is only `cd` to the project's folder.
- **A `cd` the reading does not follow (item 120).** A simple command that holds `cd`, `chdir`, `pushd`, `popd`,
  `source`, `eval` or `trap` anywhere but as text (`! cd x`, `command -p cd x`, `noglob cd x`, `repeat 1 cd x`, `then
  cd x`, `do cd x`, a function's body), or runs `.` past such words, leaves the folder unknown. A line that defines a
  function (`f()`, `function f`), an alias or a trap, sets an option of the shell (`setopt`, `shopt`: with zsh's AUTO_CD a
  folder's bare name is a `cd`), or reads text into the shell (`eval`, `source`, `.`), and any shell
  command the dial cannot read, may move the shell whenever a later command runs: the folder then stays unknown for the
  rest of the chat, a `cd` to the project's folder included.
- **Not seen.** A command an agent runs without asking (its own allow rules) is never read, so a `cd` in it is not
  carried; a shell function or alias from the person's own shell setup that moves the folder, zsh's `AUTO_CD`, and a
  `CDPATH` that sends `cd name` elsewhere are not followed either. With Claude Code these no longer carry past one command.

`command.hostile.test.ts` holds over 300 such lines, each beside the plain line it imitates, which reads as it did, and
221 everyday commands, each pinned to what it read as before item 112 (only `cdk synth` moved, to a build).

Still read as reads or checks, for the owner to decide (a design question, not a reading): a check, `terraform plan` and
`pulumi preview` run the project's own code, which an agent may have edited at Edits alone, and `terraform plan`,
`go list -m all` and a check that fetches what it needs reach the network with what the person is signed in to.
A jq or yq filter that prints the environment (`env`, `$ENV`, yq's `env(NAME)` and `strenv`) asks, as `printenv` does;
a field or key called env is only a name. jq's `--arg`, `--argjson`, `--slurpfile` and `--rawfile` are read with their
two values, so the word after them is not taken for the filter.

#### The branch a push sends (item 120)

A push that names no branch (`git push`, `git push -u origin`, `git push origin HEAD`, and `@` or `head` in any letter case,
which macOS's disk finds as HEAD) sends the branch checked out. The app reads that branch from disk when a chat starts and
when a turn ends; since item 120 the dial does not trust it in between:

- **A step that may move it makes it unknown.** A switch, a checkout, a branch made, renamed or given an upstream, a
  rebase, a bisect, `update-ref`, `worktree`, `stash branch`, `gh pr checkout`, a clone or an init, a command nobody can
  read, a shell left in another folder, and any ask the dial does not read (a tool of an MCP server's) leave the chat's
  branch unknown until it is read from disk again. Such a push then reads as live and asks. A step the dial stopped
  never ran and moves nothing.
- **The same line.** A push in a line that holds such a step anywhere, before it, beside it in a pipeline or in the
  background, is read with no branch.
- **Read again as the push arrives.** A push the dial would let go alone waits for a read of the branch from disk, beside
  the read of what it saves: one a job left running or a project's own code switched is not missed.
- **Another folder.** A push or a pull request from any folder but the one whose branch was read may be another
  repository's (a folder of the project can hold one), and asks.
- **From its own words.** A push that names its branch is read by the branch it sends to: the destination, else the
  source; `heads/main` and `refs/heads/main` are main; `:` and `+:` push every branch both sides have and a pattern every
  branch it matches, so both go live; any other namespace (`refs/remotes/`, `refs/for/`) is not known. `--branches` (the
  alias of `--all`), `--prune`, `--recurse-submodules` but `=check` or `=no`, and a push option (`-o`, which GitLab reads
  to merge a request when its pipeline passes) go live, and a pull request on a repository the words name (`-R`) asks.

A branch given an upstream (`git branch -u`, `--set-upstream-to`, `--track` or `-t` on `branch`, `switch` and
`checkout`) asks, as `git remote set-url` does: with `push.default=upstream` a later push that names no branch sends to
it. Not read: what the person's own git settings already make such a push send (`push.default=matching` pushes every
branch both sides have, `upstream` the branch it tracks, `remote.<name>.push` maps a branch elsewhere), and the upstream
git sets by itself for a branch made from a remote one. A lane's branch is made with `--no-track`.

#### Files a change to which always asks (item 88)

An edit inside the project goes alone at Edits alone, except to a file that makes a program run later or changes what an
agent may do. A change, a new file, a move into or out of, or a delete of any of these is `unknown` and asks at every
level (`guardedPath`): by any file tool, by the words a shell writes on an ask, and by a command through a word, an
option's joined value, a redirect or the folder it went into first.

- The settings, instructions, skills and plugins of every agent the app starts (`.mcp.json`, `.claude/`, `CLAUDE.md`,
  `.codex/`, `AGENTS.md`, `.agents/`, `.cursor/`, `.gemini/`, `GEMINI.md`, `.qwen/`, `opencode.json`, `.opencode/`,
  `.pi/`, `.clinerules`, `.github/` and the like).
- Files a tool on the person's side runs by itself: `.envrc`, `.husky/`, a hooks folder, `.npmrc`, `.yarnrc*` and
  `.yarn/`, `.pnpmfile.*`, `bunfig.toml`, `pnpm-workspace.yaml`, `.vscode/`, `.idea/`, `.devcontainer/`, `.cargo/`, CI
  files, pre-commit, lefthook and lint-staged settings, `.gitmodules`.
- `package.json`, `Makefile`, `justfile`, `Taskfile.yml` and the like, whose scripts a check and Preview's Start run by a
  name that says nothing of them, and `turbo.json`, which can name where turbo sends its cache (item 112).
- The app's own storage: all of `~/.manut` but the folder the session itself works in when that is a lane's own
  (exactly two names below `~/.manut/lanes`), and the web view's data and caches under `~/Library`.

A path is compared after `.` and `..` are taken out, from the project's folder, by name whatever its letter case as
macOS's disk compares it; a Windows name's trailing dots, its stream and its short form count too. Nothing is looked up
on disk, so a link the person made before is not followed; a link Kit makes asks. Reading these files does not ask.

Kit's card and Preview's Start show what a package.json script runs (`The build script runs: vite build`), from the
lane's own package.json with any key masked. A session in the developer's own folder shows the name alone, since the
shell reads only a lane's folder.

### Starting a lane

The Code page's + menu (the Terminals header's +, the empty section's New session, the background menu's New session, ⌘N and
⌘T) offers each coding agent two ways, as the owner chose on 25 November (item 66). Under its folder chip:

- **Chat with Kit**, first: one row for each installed agent that runs as the app's chat (`chatAgents`: Claude Code, Codex, OmO,
  pi, oh-my-pi, OpenCode, DeepSeek Harness, the ACP agents (Cursor and Antigravity among them since item 74) and a person's
  own, in the menu's order), with the account a new session runs as. An agent turned off on Settings › Providers is in neither
  part of the menu (`offeredAgents`), and the shell would refuse its start anyway (see [Providers](#providers-each-agents-settings)). Never Grok, which has no chat here, and never oh-my-hermes. Picking one opens its New session chat in the
  folder the chip names (`draftChat`), as a chat whatever way the draft last kept for that agent. Nothing runs until the first
  message: it names the lane's branch, the shell makes the lane's folder (see [Where a lane works](#where-a-lane-works)), and the
  agent starts there. The chat then has the pane beside it, and the Code page's Lanes band lists the lane; TERMINALS does not.
- **In a terminal**, as since 16 November and unchanged: the Shell (with Shell ▸), the installed agents and More agents with their
  install lines. The first focus is still the last agent's terminal row, so ⌘N then Enter starts a terminal.
- **Not installed.** Not in Chat with Kit: More agents names it with its install line, and once it is installed it shows in both
  parts. With no agent that can chat installed, Chat with Kit says so in one line.
- **New lane.** The Lanes band of Kit's panel has a quiet New lane link (the canvas's), drawn while the project has lanes and
  also while it has none (a person with none has the most need of it; the band is then only its heading and the link). It is not
  a second way to start a lane: it opens this same + menu (`openNewSessionMenu({ chat: true, folder })`), with the folder chip on
  the project the band shows and the first Chat with Kit row focused, so which agent and which folder are chosen where they
  always were, and `draftChat` and `ChatWay` are the only code that starts one. The + button, ⌘N and ⌘T still focus the terminal
  row. With no project at all there is no Kit panel, so no link; the + button is the way in.
- **Not signed in, said before the first message.** Where the app already reads a sign-in, the row (in both parts of the menu)
  says "Not signed in" beside the name, and its tooltip says to sign in with the agent's own command in a terminal
  (`claude auth login`, `codex login`) and that it can still start. The row stays pickable: signing in is the person's own
  step, and what the app read can be a minute old. The app reads it only for the account a new session runs as (the Accounts
  watcher's copy, `signedOut.ts`): Claude Code and Codex by the CLI's own status command, Grok (a terminal row only) by the
  bridge's state, as Settings › Providers › Accounts words it. No agent is run to find out. For every other agent, and in a
  browser, the app cannot tell and shows nothing new. Since item 74 the desktop app's shell keeps the accounts list, so
  Practice and Connected read Claude Code's and Codex's sign-in too.
- **Not signed in, said after.** Where it could not tell, the row is offered as usual. The chat starts and says what the agent answers: an ACP agent's "is not signed in. Run … in a terminal and
  sign in." with Open in Terminal, and Claude Code's or Codex's own refusal (not tried with a signed-out CLI); the lane's row says
  Failed with those words. Signing in stays the CLI's own, in a terminal.
- **Practice mode and a browser.** A session always runs on this Mac's shell, whatever Settings › Developer says about the shop's
  data, so in the first release a chat with Kit runs the person's own CLI with its own login, as a terminal does. In a plain
  browser the stand-in agent answers (`sessions/host.ts`), and `e2e/kit-lanes.spec.ts` starts a lane from the menu.
- **Asks.** A lane's asks arrive as cards and settle through `settleApproval`, with Kit's dial deciding first, as for every chat
  session. The menu adds no other path.
- **Buddy is not a lane.** Buddy's chat on Home runs the same Claude Code through the same adapter, but as a list of its own in
  the shell (`buddy_chat.rs`), in `~/.manut/buddy/chat` and never in a project, with no dial: each of its asks is a card the
  person answers, settled through approval-core (`docs/runtime-adapter.md`, "Buddy in Practice mode"). An MCP tool's ask, in a
  lane or in Buddy's chat, says the tool and its server and carries its whole input. Its chat box is a lane's box (item 80), with
  Buddy's own approval levels (Ask and Plan only, checked again in the shell), the models its Claude Code listed, a file kept as
  a copy outside its folder and named by path, and Mention a teammate.

`newMenu.test.ts` pins which agents each part lists, `ChatWay.test.tsx` draws the part and presses a row, `lanes.test.ts` takes a
pick through to the lane, and `e2e/kit-lanes.spec.ts`, `terminals.spec.ts` and `integrate.spec.ts` walk the menu in a browser.

### Providers: each agent's settings

Settings › Providers (item 74, the owner's T3 Code screenshot) is one page for the coding agents. It replaced Settings ›
Agents (whose read-only list it is now) and Settings › Accounts (now a part of it), and works in every mode: the page names
an agent id and a change, and the shell (`src-tauri/src/providers.rs`) checks every value, keeps it in its own file
`~/.manut/providers.json` (0600, written through a temporary file, never through a link) and reads that file again at each
start, so a file changed by hand never starts what the page would refuse.

- **The list.** Every agent the app offers (the built-ins, the ACP agents, a person's own), each with its version (the
  program's own `--version`, for the agents whose flag was read here: Claude Code, Codex, OpenCode, Gemini CLI, Grok, Cursor,
  Antigravity), whether it is installed, whether it is signed in where the app can read that (Claude Code and Codex, through
  the account new sessions use; Cursor and Antigravity through their own status commands, item 101a; no check is made up
  for any other agent) and a switch. oh-my-hermes, offered nowhere, is not
  listed. Pressing a row opens its settings under it.
- **Off.** Offered nowhere: neither part of the + menu, the empty section's tooltip, a new draft, Buddy (which says where to turn
  it on). The shell refuses its start before any program is looked up: terminals and chats (`sessions::launch_with`), Buddy
  (`start_buddy_mine`), DeepSeek Harness, and a person's own agent before its entry is resolved. Sessions already running
  are not touched.
- **Display name.** The name every menu, row and chat header uses (`agentDef`); the page keeps the agent's own beside it.
- **Program path.** Empty: found as always. Otherwise absolute, without `..`, and a file this account may run (on Windows an
  `.exe`, or a shim `cmd.exe` takes whole), checked again at each start. It replaces only where the program is found: the
  arguments, the chat mode and the asks stay the app's, and the install-layout warning is not shown for a path the person
  chose.
- **Home folder.** The agent's own home variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR` for pi and
  oh-my-pi, `GROK_HOME`, `GEMINI_CLI_HOME`: the ones an added account already sets), an existing folder. It is what "This
  computer" means for that agent: a session without an added account gets it, the "This computer" row's sign-in is read
  there, and an added account's settings are linked from it. A session as an added account gets the account's own folder
  instead, never both, and a variable of the same name is refused, so the two never fight.
- **Extra arguments.** One per line, each one argument, never split by a shell, in the shape `--name`, `--name=value`, `-x` or
  `-x=value` only (a word would be read as a command or a prompt, and `--` would turn the app's own arguments into words).
  They go after every argument the app adds (the chat mode, `--permission-prompt-tool stdio`, a conversation id, the
  attachment folder, the status line relay), so a value-taking option of theirs at the end can only fail, never take one
  of the app's as its value; for an agent whose chat starts with a word (Codex's `app-server`, the `acp` of OpenCode,
  Kimi Code, Cursor and Antigravity) they are that word's options. Refused by name, compared with every `-` and `_` taken
  out and case folded on both sides (yargs, Gemini CLI's parser, also reads `--approval-mode` as `--approvalMode`), as a
  `--no-` form, in yargs' dot form (`--sandbox.enabled=false`) and with a value: the options that skip the asks or the
  sandbox, and the ones the app sets itself (the chat mode, the conversation, the folder, where the asks go), as each CLI's
  own `--help` spells them and with the hidden spellings found since (`ARG_RULES`, with the page's copy
  `src/settings/providers/argRules.json` held equal by a Rust test):

  | Agent | Refused as skipping the asks or the sandbox |
  | --- | --- |
  | Claude Code | `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--permission-mode`, `--allowedTools`, `--allowed-tools`, `--settings`, `--setting-sources`, `--agents`, `--add-dir` |
  | Codex | `--dangerously-bypass-approvals-and-sandbox` and its hidden `--yolo`, `--full-auto` (before 0.147), `--dangerously-bypass-hook-trust`, `-a`/`--ask-for-approval`, `-s`/`--sandbox`, `--approve-for-me` and its hidden `--not-so-yolo`, `--add-dir`, `--search`, `-p`/`--profile`, `--enable`, `--disable`, `--trust`, and `-c`/`--config` whose key starts with `approval`, `sandbox`, `profile`, `default_permissions`, `permissions`, `projects`, `mcp_servers`, `features` or `shell_environment_policy` |
  | OpenCode | `--auto`, `--yolo`, `--dangerously-skip-permissions` |
  | Gemini CLI | `-y`/`--yolo`, `--approval-mode`, `--allowed-tools`, `--policy`, `--admin-policy`, `--skip-trust`, `-s`/`--sandbox`, `--include-directories` |
  | oh-my-pi | `--auto-approve`, `--approval-mode`, `--yolo`, `--plan-yolo`, `--plan-yolo-into`, `--add-dir`, `--config`, `--profile`, `--allow-home`, `--hook`, `-e`/`--extension`, `--trusted-extension`, `--plugin-dir` |
  | Grok | `--always-approve`, `--allow` (and its `--allowedTools`, `--allowed-tools`), `--permission-mode`, `--sandbox`, `--add-dir`, `--agents` |
  | Cursor | `-f`/`--force`, `--yolo`, `--auto-review`, `--sandbox`, `--approve-mcps`, `--trust`, `--add-dir`, `--plugin-dir` |
  | Antigravity | `--dangerously-skip-permissions`, `--mode`, `--settings`, `--add-dir`, `--sandbox` |

  The rule turned round (security review, 25 Nov 2026). These lists were read from `--help`, which prints no hidden
  option or alias, so none of them can be shown whole; before, `--approvalMode=yolo`, `--skipTrust` and
  `--includeDirectories` passed for Gemini CLI, and `--yolo` for Codex. So besides the refusals, an option is taken only
  from a short list known to be harmless for that agent (which model, how hard it thinks, what it logs, how it draws, and
  options that only take something away); anything else is refused as not on the list (`arg_unlisted`), naming the option
  only:

  | Agent | Taken |
  | --- | --- |
  | Claude Code | `--model`, `--fallback-model`, `--effort`, `-n`/`--name`, `-d`/`--debug`, `--betas`, `--ax-screen-reader`, `--disallowedTools`/`--disallowed-tools`, `--disable-slash-commands` |
  | Codex | `-m`/`--model`, `--oss`, `--local-provider`, `--strict-config`, `--no-alt-screen`, and `-c`/`--config` for `model`, `model_reasoning_effort`, `model_reasoning_summary` and `model_verbosity` only |
  | OpenCode | `--log-level`, `--print-logs` |
  | Gemini CLI | `-m`/`--model`, `-d`/`--debug`, `--screen-reader` |
  | oh-my-pi | `--model`, `--smol`, `--slow`, `--plan`, `--models`, `--thinking`, `--hide-thinking`, `--no-title`, `--max-time`, `--warn-cost`, `--max-cost`, `--motion` |
  | Grok | `-m`/`--model`, `--reasoning-effort`, `--debug`, `--disable-web-search`, `--disallowed-tools`, `--no-alt-screen`, `--max-turns` |
  | Cursor | `--model` |
  | Antigravity | `--model`, `--effort`, `--disable-slash-commands` |

  The agents whose options could not be read on this Mac (OmO, DeepSeek Harness, pi, Qwen Code, Kimi Code and Copilot CLI are
  not installed here, and Cline's `--help` did not return) take no extra arguments, and a person's own agent keeps its own on its entry. Buddy takes none
  at all, so its `--permission-mode default` stays the last word on its asks.
- **Environment variables.** Names and values, for that agent's chats and terminals only, not Buddy's. They come before the
  home and the app's own variables, which therefore win; the names the app sets itself (`PATH`, `HOME`, `TERM`, `COLORTERM`,
  `TERM_PROGRAM`, `MANUT_*`, OpenCode's `OPENCODE_CONFIG_CONTENT`) and the home variable are refused, and so is every
  variable a CLI's own documentation or program names as skipping its asks, lifting or changing its sandbox, or pointing it
  at another settings or configuration file (`ArgRules::vars`, security review, 25 Nov 2026): Claude Code's
  `CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS`, `CLAUDE_CODE_SANDBOXED`, `CLAUDE_CODE_MANAGED_SETTINGS_PATH`,
  `CLAUDE_CODE_SHELL_PREFIX` and the others in `ARG_RULES`; Codex's `CODEX_EXEC_SERVER_URL`; Gemini CLI's
  `GEMINI_CLI_SYSTEM_SETTINGS_PATH`, `GEMINI_CLI_TRUST_WORKSPACE`, `GEMINI_SANDBOX`, `SANDBOX`, `SEATBELT_PROFILE` and the
  rest; OpenCode's `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME`; oh-my-pi's `PI_CONFIG_DIR`,
  `PI_CONFIG_FILES` and the shell prefixes; Grok's `GROK_SANDBOX`, `GROK_AUTO_PERMISSION_MODE`, `GROK_CONFIG_PATH` and the
  rest; Cursor's `CURSOR_CONFIG_DIR` and `CURSOR_SANDBOX_POLICY_DIR`. Names are compared as options are, without case or
  `_`. Antigravity's documentation names none. The person is setting their own tool, so these refusals are for a mistake
  or a line pasted from somewhere, and the page says so in one line under the fields.
  OpenCode's ask rules are read with the person's variables, so one that changes its own rules is read too. A value is a
  secret: it stays in the shell's file and goes only into the agent's process; the page, an event, a refusal and a `{:?}`
  name the variable, never its value (`View` carries names, `Var`'s `Debug` hides it). A saved variable shows as its name with
  "Saved, hidden"; Save without retyping keeps the value the page never had.
- **Accounts in every mode.** The Accounts page hid itself in Practice and Connected because its list and its changes
  (`accounts.list`, `add`, `set_active`, `remove`, `label`, `discard`) were the Hermes bridge's ops, which only the WebSocket
  runtime has. What they did was read and write folders and two small files under `~/.manut/accounts`, and the sign-in and
  the status were already the shell's, so the shell now does them (`accounts::list_here` and five more, for Claude Code and
  Codex, the CLIs whose sign-in it runs and reads); the page asks the shell in the desktop app and the runtime elsewhere. The
  bridge's usage records and CLIProxyAPI rows are not read by the shell: a row's usage meter shows only where a bridge is.
- **Cursor and Antigravity.** Both CLIs start an ACP server (`cursor-agent acp`, `agy acp`, read in their own help on this Mac)
  and ask the client with `session/request_permission` before acting (Cursor's documentation, cursor.com/docs/cli/acp, and
  its bundle, which asks before a write, a delete, a read, a command and an MCP tool unless `--force`; Antigravity's help,
  whose `--dangerously-skip-permissions` is what turns its requests off, and its binary). So both are rows of `ACP_LIST`,
  continued with `session/load` (Cursor) or `session/resume` (Antigravity offers it, and the adapter takes it first).
- **Cursor and Antigravity as chats (item 101a).** Each ran here as a chat, two short messages each (Antigravity 1.5.18:
  "ok", then `pwd` asked for, allowed and run in the chat's folder; Cursor Agent 2026.11.22: its account's plan had run out,
  which it says in its own reply), recorded in `src-tauri/tests/fixtures/acp/agy-*.jsonl` and `cursor-1-plan-limit.jsonl`.
  What the generic ACP adapter (`acp_chat.rs`) does for them:
  - **Modes.** Each row lists the session modes in which its agent asks (`asks_in`): Cursor's `agent`, `plan` and `ask`;
    Antigravity's `default` only, since its `accept-edits` approves edits and its `auto` approves edits and "safe" commands
    unasked, and its default mode is a setting of its own. When the agent reports any other mode, when the conversation
    opens or later, the adapter sets the row's first mode back (its `mode` option, else `session/set_mode`), stops a running
    turn and expires its cards, and sends nothing until the agent confirms; the chat says so once. An agent that will not
    go back gets nothing more, and the chat says to start a new one.
  - **Cursor's own settings.** Cursor's ACP server reads the person's permissions from `cli-config.json` (in
    `CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else `~/.cursor`), and its `approvalMode` of `unrestricted` (Run
    Everything) runs every command and change unasked, whatever the mode. So a Cursor chat starts only when that file is
    absent or its `approvalMode` is absent or `allowlist`; anything else (Auto-review, Run Everything, a file that cannot
    be read) refuses the start with a sentence that says to set Approval mode to Allowlist. Read once at the start: a change
    to the file while the chat runs is not seen. A project's `.cursor/cli.json` cannot set the mode (its schema holds only
    `permissions`).
  - **Cards.** Antigravity names its command `CommandLine` and its folder `Cwd`, and its files `TargetFile` or
    `AbsolutePath`; the card and Kit's dial read them. Its request ids are strings, answered as given. Cursor's requests
    carry no input: a command is the title between backticks, shown whole on the card, and Kit's dial, which never reads a
    title, asks; a change names its file in the diff it carries, which both read. "Allow always" is never offered.
  - **Questions.** Cursor asks its own questions as a permission request whose answers are several `allow_once` options and
    whose "Skip" is a `reject_once`; that becomes a question card with those answers. An answer that is none of them is
    refused and the card stays.
  - **A loaded conversation.** Cursor continues with `session/load`, which replays the conversation before it answers; the
    replay is not shown as the reply of a message sent meanwhile.
  - **Sign-in.** Settings › Providers reads Cursor's `status --format json` (only whether it is signed in, and the email)
    and Antigravity's `models` (signed in when it lists models; it has no status command), one at a time after the
    versions, and Report a problem reads them the same way.
  - Not done: Antigravity's thinking level (`thought_level`) has no switch here, as for the other ACP agents. Cursor's ask
    path was checked against its bundle, not a real tool call, since its account could not run one here.

`providers.rs`' tests pin each check, the order of a start's arguments and that a value never leaves; `agent_chat.rs`'
`providers_settings_reach_a_chat_and_never_weaken_its_start` and `sessions.rs`' terminal twin start a stand-in program and
read back exactly what it was given; `accounts.rs` pins the shell's list. `src/settings/providers/*.test.ts(x)` pin the page's
own check, the patch, the words and the mock host, and `e2e/agents-settings.spec.ts` walks the page.

### Pinned, snoozed, settled and archived

Item 76 (the owner, 25 Nov, from T3 Code's Labs). The same four choices are in the menu of a row, never as buttons on every row: a
quiet "more" button that shows on hover and focus, and a right-click. A chat (Buddy's threads: Recent in the sidebar and History) and a
lane (the Lanes band) have Pin, Snooze, Done for now and Archive; a terminal session has Pin and Done for now, since it has no
conversation to put away. A row is in one place: each choice replaces the others. The rules are `sidebar/rows.ts`; the menu is
`sidebar/RowMenu.tsx`.

- **Pinned** rows sit on top of their list in the order they were pinned (first pinned on top), with a small mark. In Recent the
  pinned do not count against the three newest; in a terminal's folder group they come first.
- **Snoozed**: hidden until a time from three plain choices (an hour, tomorrow morning at 9:00, next Monday at 9:00 on this computer's
  clock), or until something in the row needs the person. A snoozed chat leaves Recent but stays in History, tagged "Snoozed until
  09:00", so it can always be found; a snoozed lane is behind the Lanes band's "Snoozed and archived (n)" line.
- **Done for now** (settled): the row drops below the others, smaller and quieter, until it is opened or something needs the person.
- **An ask always brings a row back.** `placeOf` shows a snoozed or settled row that needs the person in its normal place whatever its
  marks say, and `RowsWatcher` clears the mark as the ask arrives (a chat with an open approval or question, a lane whose chat has one,
  a terminal that rang), so the row stays back once the ask is answered. Opening a settled row clears its mark; a snooze that has run
  out is dropped when its time comes (one timer, for the next snooze only). Needs you is unchanged: none of this ever hides an ask.
  Pinned stays on top and archived stays archived (the person's own word), and in both cases the ask is still in Needs you.
- **Archive.** A chat leaves Recent and History's days and is listed in History's Archive, a heading at the foot of the page that
  opens its list; a lane leaves the Lanes band and is listed behind its "Snoozed and archived (n)" line. Each is brought back from its
  own menu ("Bring back from the archive"). Archiving only sets a mark: it never closes a session or touches a lane's folder or
  branch (Settings, Worktrees and Kit's kept folders handle those).
- **Where it is kept.** Every row's marks are kept on this computer (`localStorage` `manut.sidebar.rows`). Since item 94 a lane is known
  by its own folder (`lane:<folder>`, whose record is under `~/.manut/lanes`) and a terminal or a lane with no folder by its link id
  (`session:<linkId>`, drawn when the session is made and kept across restarts), never by the session's number, which a later run may
  give to another session; so their marks come back with the sessions' list after a restart. A session's marks go when this run saw it
  listed and then closed (a terminal closed with Undo still open keeps them). A record saved before this (no marks) reads as none,
  and a field this build does not know is dropped when it is read, never an error.

### The sidebar as an inbox (item 94)

The rest of T3 Code's inbox (the owner, 26 Nov; `docs/t3code-parity.md`), on the same marks. The rules are `sidebar/rows.ts`,
`sidebar/selection.ts` and `sidebar/inbox.ts`; each has its tests beside it, and `e2e/inbox.spec.ts` walks the select-several, the
undo toast, the picked time, the Working group and a quiet chat settling, in light and dark (`INBOX_SHOTS=<dir>` keeps the pictures).

- **Undo.** Pin, Snooze, Done for now and Archive are held for six seconds, the newest one only, with exactly the mark each row it
  touched had before; Undo puts that back and nothing else, for one row or every row of a bulk action. The app's one toast (the closed
  terminal's, `sessions/CloseToasts.tsx`) shows it with Undo and no countdown, and ⌘Z (Ctrl+Shift+Z elsewhere) takes it back while the
  focus is in the side menu, on a row (`data-row-key`) or on the toast; a chat box or a terminal keeps its own ⌘Z. After a menu
  choice the focus goes back to the row's "more" button, so the key reaches it. An ask still wins: the watcher wakes a row that asks
  whatever an Undo put back.
- **Snooze until.** After the three fixed times, "Until it finishes" for a chat or lane whose turn runs (back when the turn ends, or at
  once when it asks), and "Pick a time" with a date and a time field (the kit's form parts), which refuses a time that has passed or
  does not exist, in the app's own words.
- **The Working group**, off by default (Settings › General › Side menu, the group that also holds the tasks bar). When on, a chat whose
  turn runs waits in a quiet "Working" list under Recent and is back on top of Recent when its turn ends (the end is its newest
  activity). A chat that asks something, a pinned one and a settled or snoozed one are never put there.
- **Several rows at once**, in Recent (with the Working group) and in History's days: Shift-click selects from the last row picked,
  Cmd-click (Ctrl-click elsewhere) adds or removes one, Shift with an arrow does it from the keyboard, Escape clears, and a plain click
  still opens its row. A selected row has the kit's selected band (`data-sel`). The menu of a selected row offers Pin, Snooze, Done for
  now and Archive for all of them ("2 chats"), and one Undo takes the whole action back.
- **Settling by itself**, two choices in the same Settings group, each with its plain line. A chat or lane with no message either way
  and no ask waiting for 3 days (Off, 1, 3, 7 or 14) is marked Done for now, counted from the last thing the app knows happened in it:
  a runtime that does not say when a chat last moved (Practice's) gives no time, and such a chat is left alone until something
  happens in it this run. A lane whose pull request the host said merged is marked Done for now too (on by default): "said" is a list
  the app read showing this repository's own request merged (`tasks/pulls.ts` `mergedFor`), or the app's own Merge finishing; a
  request that is just no longer open never counts, and a fork's never does. A row the person marked, one working, one asking and the
  one open are never settled this way, and Undo does not hold it (the person did not do it). A mark that leaves a row notes when
  (`back`), so the quiet days count from there and a row brought back is not put away again at once. The row's quiet second line says
  why: "Done after 3 quiet days", "Done: its pull request merged" (Recent, History's tag, a lane's line).
- **The pull request on a lane's row.** The shell's pull request list now carries the branch each request is made from (`gh`
  `headRefName`, GitLab `source_branch`). A lane's own branch is matched to the open requests of its repository: those the Tasks page
  has already listed, else one read of that repository's first page when the cache is older than five minutes. It is one call for the
  repository, never one per lane and never on a timer: it runs when the Code page shows a lane with a branch of its own, a failed read
  is not tried again within the five minutes, and a missing or signed-out `gh` shows no pull request. Nothing is written to GitHub or
  GitLab. `tasks/pulls.ts`.

### Titles and words by a model (item 96)

Settings › General › Titles and words lets the person's own Claude Code write a chat's title and a pull request's words. It is **off**
until turned on, and it works with Claude Code only: its `--help` names the three switches a run with no tools and no project needs,
and no other agent here has been checked. The setting says so.

- **The run** (`src-tauri/src/title_run.rs`, commands `title_run` and `title_cancel`): `claude -p` with `--tools ""`, `--strict-mcp-config`
  and no MCP config, `--disable-slash-commands`, `--permission-mode default`, `--no-session-persistence`, `--setting-sources user`, and the
  chosen `--model` and `--effort` (each checked). It starts as a chat does (the allow-list, the child `PATH`, the account's home) in the
  empty folder `~/.manut/titles`. The text goes in on standard input, masked and cut to 6,000 characters, inside a fence one backtick
  longer than any run of backticks it holds, so nothing in it can close the fence (item 117). One run at a time, 45 seconds, four
  starts a minute, cancel by key. The answer is cleaned and only returned: since item 117 a title and a description are plain words
  only, with every image, link target, bare address and HTML tag dropped (`plain`), so a description cannot make GitHub fetch an
  address that carries a private diff's words when the pull request is shown. Its rate-limit event reaches the usage the meter reads.
- **A chat's title** (`sessions/titleWords.ts`): after a turn ends done, from the first message and first answer. It becomes
  `SessionRec.modelTitle`, which `pickTitle` ranks below a name the person gave and above the agent's title and the summary. A result that
  arrives after a rename is dropped. Row menu › Write the title again asks for another, and is offered only for a chat the person has not
  named. A failed automatic run is quiet; a failed ask says why.
- **A pull request's words**: Suggest in the review draft sends the lane's commit subjects and changed files with a few lines of each,
  masked, and fills the title and description to be read and changed. A file whose name says it holds keys (`.env`, a private key, a
  keystore, an `.npmrc`; `holdsKeys` in `sessions/titleWords.ts`) gives its name and none of its lines, since masking knows a key only by
  its shape. Ask, and the ask's own yes, are unchanged. The setting has a row, "What it reads", that says all of this.
- **Not done**: commit messages, and any agent but Claude Code.
- **Checked**: Rust stand-in tests (`title_run` module, a stand-in program for the CLI, so no real agent runs), `sessions/titleWords.test.ts`,
  `settings/TitlesRows.test.tsx` and `code/Review.test.tsx`. How a real Claude Code answers, and how Suggest looks in the review draft (no browser spec reaches that draft), are a
  hands-on pass that spends the owner's tokens. The lead looked at the Settings rows in light and dark at 1280 and 900.

### The suggested next message

After a turn ends in a coding chat, the empty box may show one predicted next message in grey; Tab takes it into the box (where it is
the person's own text), typing replaces it, and nothing is ever sent by itself. It costs an extra request on the person's own plan after
every turn, so it is **off** until Settings › General › Suggested next message is turned on, and the setting says so in plain words.

- **Claude Code** offers an honest way: `claude -p --prompt-suggestions true` (from `claude --help`: "In print/SDK mode, sends a
  prompt_suggestion message after each turn with a predicted next user prompt"). Claude Code makes it with a request of its own that
  never enters the conversation's history. The shell adds those two arguments to a Claude Code chat only when the setting is on
  (`sessions.rs` `CLAUDE_SUGGEST_ARGS`, `agent_chat.rs` `suggest_args`) and turns the `prompt_suggestion` line into a `suggestion`
  event (`{type, suggestion, uuid, session_id}`). The flag is chosen when the chat starts, so it applies to chats started after the
  setting was turned on; turning it off stops the box showing them at once (a late one is dropped).
- **Codex**: its app-server protocol (`codex app-server generate-json-schema`, 0.169.0) has no such request. **Every other agent**: none is
  known to offer one. A side question would land in the chat's own history, so none is made, and the setting says it works with Claude
  Code only.
- **Not seen live yet.** Two one-turn probes of a real Claude Code 2.1.332 (`-p`, then stream-json input kept open for 30 s) sent no
  `prompt_suggestion`: it seems to wait for a longer conversation. The message shape comes from Claude Code's own schema, and the
  mock host (`__manutMockSuggestion`) stands in for it. A hands-on pass on a real chat of a few turns is still to do.
- Not Buddy's chat: it is started by `buddy_chat`, not by a coding session, and its box is not a coding chat's.

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
canvas's Code board draws Kit's lane that way ("Tell Kit what to change", Kit's note). The Code page's + menu offers each
coding agent both ways (the owner, 25 November, item 66): Chat with Kit starts such a lane, and In a terminal starts the
agent in its own terminal, as since 16 November, where its prompts stay inside the terminal, so the dial does not reach
those sessions yet. The Code page shows the dial for every project either way.

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
the same session, and not a Hermes folder chat), opened on Diff. It looks at what the session did and changes nothing; the one
thing it starts is the lane's preview, when the person presses Start.

- **Where it is.** To the right of the chat while the session view holds both: the chat takes `3 1 440px` and the pane
  `3 1 380px`, as the canvas's `.split` lays out its `.pane` and `.side2`, and the pane is no wider than 640px. When the session
  view is narrower than 820px (a narrow window, or the Plans panel open beside one) the pane goes under the chat, as the canvas's
  side pane goes under the page under 920px: a top rule, at most 45% of the window's height, a scroll of its own, so the chat
  keeps its box for typing. The width is the session view's own (a container query), not the window's, since the side menu and
  the Plans panel take theirs first. `e2e/lane-pane.spec.ts` measures both.
- **Diff.** What really changed in the lane's own folder, read from git (item 71; `code/laneFolder.ts`, `code/useLaneFolder.ts`,
  `src-tauri/src/lane_diff.rs`): every file that differs from the commit the lane started from, uncommitted work, files git has
  not seen yet and the lane's own commits included, the file that changed last first. Each is drawn by the timeline's own diff
  view (`DiffView` in `chat/activity/Work.tsx`): the path, its state (new, deleted, "renamed from `old`"; changed has no tag),
  the added and removed counts, the lines in mono, and `maskSecrets` over every line (the shell masks them first, with the
  same `mask_secrets` as every CLI answer, so a key is never shown nor sent to the page). The folder is the truth, so after an
  app restart the pane is not empty, a subagent's edits and an edit by hand show, and a file the agent rewound disappears. The
  chat's events are only the hint to read again (`changeMark`: a step began, ended or got its change, a subagent took a step
  or ended, the turn ended) and the fallback. It is read when the lane opens, on such a hint, and never on a timer, at most
  once a second and never two at once (`folderReader`); a read that fails keeps what was shown. Where the shell cannot read (a
  plain browser, the tests' stand-in host, a session in the developer's own folder) the pane keeps the old behaviour: the
  files the chat's own steps changed (`changedFiles`, from `Step.diff`, which `tool.diff` events carried; a Rewind to before a
  turn takes its files out). The pane's diff has ids of its own (`lane-diff-*`) and does not scroll itself into view.
  "Kit has not changed any file yet." is said only while none is listed.
  - **What the shell reads** (`lane_diff`): only a folder the app made (the check the removal paths use, `own_lane`, plus git
    listing it as a worktree of the recorded repository; a lane started in a subfolder is read at its subfolder too). It only
    reads, through the lane's own `Git` runner (no hook, no file monitor, no prompt, no optional lock) with `--no-ext-diff
    --no-textconv`, so no program the repository names runs to draw a diff; a repository whose own config, or a submodule's,
    names a clean filter is not read at all (see "Git the app runs by itself"), and a submodule is never one of the files nor
    read inside (item 90). A file git ignores never shows, so a `.env` and the agent settings copied in (item 72) do not.
  - **Bounded, and said.** At most 100 files ("and 12 more files"); a file whose diff is over 256 KiB or that is over 2 MiB on
    disk says "Too large to show."; a binary file says it is binary; the diffs together stop at 1 MiB, and the files after that
    are listed with "Not shown: this list is already long."; the whole read stops at 15 seconds the same way. A page draws at
    most 400 lines of a file ("N more lines").
  - **The start.** The commit the lane's branch was made at (its record's `at`), so a base branch that moved does not put its
    changes in the Diff (the Code page's note says it moved). Once the base has been rebased onto or merged into the lane, the
    commit where the lane and the base branch parted stands in, so only the lane's own work shows.
  - **Renames.** Git pairs a deleted and an added file among the tracked ones (its default 50% similarity); a new file git has
    not tracked yet shows as new next to the deleted old one until it is added.
- **Preview.** The lane's project run with its own dev server in the lane's own folder (`LanePreview.tsx`; see
  [The preview of a lane](#the-preview-of-a-lane)): the command named first with Start, its state as it runs, its page in a frame
  that fills the view while it runs ([The page in the pane](#the-page-in-the-pane)), the names of the
  secrets it runs on samples, and under it the Sample rows of the secrets Kit's changed code reads (`needsOfChat`, drawn by
  `PreviewSampleView` as on the Code page, without the band that the chip names), each with Add, which says the vault comes
  later. A session that works in the developer's own folder gets no Start.
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

The words are in en, ko, ja and zh. `LanePane.test.tsx` draws each view and the chips from props, the preview's states among
them, `changes.test.ts` drives the chat's own reducer through a rewind, `Work.test.tsx` holds the diff view's ids and its scroll,
and `e2e/lane-pane.spec.ts` walks the pane in a browser (`e2e/preview-run.spec.ts` the preview's run).

### The preview of a lane

The canvas's Code board has a Preview beside an open lane. The desktop runs the lane's project with its own dev server, in the
lane's own folder, says where it runs, and Open hands that address to the person's browser (`src-tauri/src/preview.rs`,
`code/previewRun.ts`, `code/previewStore.ts`, `code/previewHost.ts`, `code/LanePreview.tsx`).

- **Only in a lane's own folder.** A folder two names or more below `~/.manut/lanes`, read after every link is followed. A session
  that works in the developer's own folder gets no Start, and its Preview says why: that folder can hold a real `.env.local`, and
  a lane's worktree has none, since git ignores it and nothing ignored comes into a lane.
- **The command, named first.** Each time Preview is looked at, the shell reads the lane folder's `package.json`, the names at its
  root and its `.env.example` (`preview_read`: a link is never followed, and a `package.json` over 512 KiB reads as unreadable).
  `@manut/preview-command` chooses: `dev`, `start`, `preview` or `serve`, the first that is there and does not look like it
  publishes (nor does its pre or post script), run by the manager the `packageManager` field or the lockfile names. The view
  shows it as `$ pnpm run dev` with Start, or says in words why there is none: no package.json, one that cannot be read, no such
  script, or scripts that look like they publish or deploy.
- **Start.** The folder is read again and the command chosen from what it holds now. The shell (`preview_start`) runs it only when
  it is one of the sixteen commands the package can choose, as a list of words with no shell, with the manager found where a
  chat's agent is found, and only while package.json is still the text the page chose from; otherwise `changed`, and the view
  shows the command it would run now. One preview per lane.
- **What it runs with.** An environment that starts empty. From the app's own: `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`,
  `LANG` (`en_US.UTF-8` when the app has none, as a chat gets it) and the `LC_*` categories; `PATH` as a chat gets it (the
  manager's folder first); `TERM=dumb`, since the output goes to a pipe read as plain lines. Then each secret the preview knows
  of, set explicitly so that it wins over a `.env` file the framework loads (`previewSecrets`): each name Kit's changes read
  through `previewEnv` (a sample, unless the owner added that very secret, which nothing can do yet), each variable
  `.env.example` marks as a secret by its own rule with `sampleEnv`'s fake value, and each `.env.example` name that says what kind
  of secret it is through `previewEnv` too, so a shop ID is all zeros whatever its line wrote. Its other variables (`PORT`) are
  left to the project. Nothing else of the app's environment reaches it. The view names the secrets that run on samples; no
  value is ever on the page.
- **Its states.** Starting, until it prints an address of this computer (`@manut/dev-url`) or for a minute. Running at that
  address, with Open and Stop. After a minute with no address: that it runs but has printed no address the app can open, with
  its last lines and Stop (an address printed later still counts). Stopping, then Stopped. Ended by itself, with its exit code
  and its last six lines, each through the app's masker. Could not start, with why in words: not a lane's folder, a command or a
  secret's name the shell will not take, package.json changed, a preview already running, the manager not installed, Windows.
  Start again after any end.
- **Its lines.** stdout and stderr go to the page as they come, every 50 ms and at most 500 at once, a line cut at 4 KiB, a progress
  line read as what shows last; the shell keeps none. The page keeps the last 200, in memory only, with a terminal's escapes taken
  out.
- **Open in browser.** `preview_open` takes only `http` or `https`, then `localhost`, `127.0.0.1` or `[::1]`, a port or none, and a
  closing `/` with nothing after it (`loopback_url`), and hands it to the system opener. The same address is what the pane draws
  while the preview runs ([The page in the pane](#the-page-in-the-pane)).
- **Stop, and the other ends.** Stop hangs up the preview's process group, as a chat's close does, and kills what still runs 1.5
  seconds later. A preview also stops when its lane's session closes, when the page loads again (`preview_close_all`) and when the
  app quits; a start the shell answers after its lane closed is stopped at once. When its program ends by itself, what it started
  goes with it.
- **What keeps running** lists each preview, tagged Preview and named by its lane, with the ports of everything it started; its Stop
  is the preview's own, so the pane says Stopped.
- **Where.** macOS and Linux. On Windows the view says the preview runs on macOS and Linux for now.
- **In a browser.** No shell, so a fake preview (`MockPreviewHost`) prints a dev server's lines and its address and lists itself
  with what keeps running; `window.__manutMockPreview` says what a folder holds, how the run goes and the address it prints (`url`,
  Vite's `http://localhost:5173/` unless given), and `window.__manutPreviewCalls` records each call. A test can instead stand in for
  the shell's four preview commands (`window.__manutPreviewShell`, a stubbed shell, read only outside the desktop app): the page
  then runs the desktop's own host, `TauriPreviewHost`, against it. `e2e/preview-run.spec.ts` walks it in light, dark and narrow
  and in ko, ja and zh.

The tests: `preview.rs` (the environment, the sixteen commands, the folder, the address Open takes, and real runs with a stand-in
manager: its words, its folder, its environment, Stop ending its whole group, an end by itself, `changed`, `running`),
`running.rs` (a preview's row), and `previewRun.test.ts`, `previewStore.test.ts`, `previewHost.test.ts`, `LanePane.test.tsx` and
`RunningPanel.test.tsx` on the page.

### The page in the pane

The board draws the preview's page in a box under the chips (`New Year gift set`, the QR code, `฿590`). While a lane's preview runs
at an address, the desktop draws the page at that address in a frame that fills the rest of the view, under the preview's box,
whose buttons are then Reload, Open in browser and Stop (`LanePreview.tsx`, `PageFrame`; `previewFrame.ts`). Under the frame one
line says what does not open in it. The frame goes the moment the run is no longer Running: Stop pressed, stopped, ended, its
session closed.

- **Which address.** Only the one its own lane's preview printed and runs at, as `@manut/dev-url` read it, and only when it passes
  the rule Open keeps in the shell (`loopbackUrl` on the page, `loopback_url` in preview.rs, one table for both:
  `code/__fixtures__/loopback.json`). Then only on `localhost`, the one host the CSP names; never the app page's own origin (in a
  debug build the dev server is the app's page to Tauri, so a frame there would be the app, with its origin); and never on Windows.
  Otherwise the box says why in words and keeps Open in browser: `[::1]` ("The app shows a page inside it only at localhost"), the
  app's own address, Windows, or an address that is not this computer's (which `@manut/dev-url` never answers; the page looks again).
- **Reload** makes the frame again at the preview's address: the page is another origin's, so the app cannot ask it to reload
  itself, and a page the frame moved to inside the dev server is left for the preview's first page.
- **The sandbox:** `allow-scripts allow-same-origin allow-forms`, and `referrerpolicy="no-referrer"`. Scripts, since a dev server's
  page is a script app. Its own origin, which its module scripts, its reload socket and its storage need (an opaque origin fails a
  dev server's own CORS and WebSocket checks), and which is never the app's, so it reaches nothing of the app's. Forms, so a form
  posts to its own server. Nothing else: no top navigation of any kind, so it cannot move the app's window; no pop-ups; no dialogs
  over the app; no downloads, pointer lock, presentation, orientation lock or storage-access prompt. The page keeps its own white
  canvas in both themes, as a browser tab shows a page that sets no background.
- **The CSP.** `frame-src` is `http://localhost:* https://localhost:*` in both `csp` and `devCsp`; every other directive is as it was
  (`previewFrame.test.ts` pins them). WebKit applies the embedding page's `frame-src` to every navigation of a frame, not only its
  first address (`PolicyChecker::checkNavigationPolicy`), so a link in the page to another site, and the app's own
  `tauri://localhost` pages, never load in it. A CSP source cannot name `[::1]`: WebKit refuses the frame even with
  `http://[::1]:*` written (its host grammar takes letters, digits and `-` only), hence Open in browser there. An `https` dev
  server shows only when its certificate is one the system trusts.
- **The shell looks again.** The app's window has a navigation hook (lib.rs `app_window_guard`, the main window only; the
  outpost's window keeps its own): it lets the window and its frames load only the app's own pages, `about:blank`, `about:srcdoc`
  and pages on an address of this computer by `loopback_url`'s rule with any path (`app_window_may_load`), and cancels anything
  else. wry asks it about every frame's navigation as well as the window's, with only the address, so it is a second check of what
  the frame loads, whatever the CSP says, and it also keeps anything from taking the window to another site. It cannot tell the
  frame from the window, so it lets both load loopback pages and the app's own pages: the sandbox keeps the frame from moving the
  window, and the CSP keeps the app's pages out of the frame.
- **No way into the app.** Tauri (2.12.5) puts its scripts, the invoke key among them, in the main frame only on macOS and Linux
  (WKWebView's and WebKitGTK's main-frame user scripts), so the frame has no `__TAURI_INTERNALS__`. It can still reach wry's `ipc`
  message handler and the `ipc://` scheme, and both reach Tauri, which drops a call without the key unanswered; a call with the key
  from the frame's origin is refused by Tauri's check, since no capability names a remote page (`src-tauri/src/outpost/mod.rs`'s test keeps it so, and lib.rs's sends every command from a preview's origin). Tauri
  lets one command skip that check for any page with the key (`plugin:__TAURI_CHANNEL__|fetch`, a channel's data), which is why
  the frame stays off on Windows: WebView2 puts every script in every frame. The app listens to no `message` from a frame.
- **macOS versions.** Drawn on every macOS the app supports, with no version gate. Checked on this Mac (macOS 27.2.1, Safari 27.2's
  WebKit) with a scratch Tauri program on the app's Tauri, CSP and sandbox, page served from `tauri://localhost`: the frame draws;
  it has no `__TAURI_INTERNALS__`; a guessed key and the real key (handed over by the scratch, which a frame can never get) both
  run nothing; a pop-up gives `null`; the top frame throws `SecurityError`; a link to another site is refused by the CSP alone and,
  with the CSP opened wide, by the shell's hook alone, and loads only when both are off; the frame cannot load `tauri://localhost`;
  `[::1]` is refused even when named. Not run on macOS 11, which this Mac cannot be. For it, WebKit's source of late 2020 shows
  that mixed content is checked only for an `https` page (`MixedContentChecker`: "We only care about HTTPS security origins"), so
  a `tauri:` page may frame `http://localhost`, and that `frame-src` is checked for every navigation of a frame
  (`PolicyChecker`); the sandbox, main-frame-only user scripts and the navigation delegate the shell's hook hears are all older
  than macOS 11. Apple's transport security does not apply to `localhost`.
- **In a browser.** The fake preview prints the address a spec gives it (`__manutMockPreview.url`), and a stubbed shell can stand in
  for the shell (`__manutPreviewShell`); `e2e/preview-frame.spec.ts` answers that address itself (`page.route`, as
  `outpost-scripts.ts` serves its pages) and serves the app's page with the app's own `frame-src`, then walks the frame drawn, its
  sandbox, the top navigation, the pop-up and the other site refused, its own pages and form working, Reload, Open in browser, the
  frame going on Stop and on the session closing, another computer's address and `[::1]` never framed, the stubbed shell, and light,
  dark, narrow, ko, ja and zh. `e2e/preview-frame-webkit.spec.ts` runs all but the layout walks in WebKit on a Mac.

The tests: `previewFrame.test.ts` (the shared table, which address is framed and why not, the sandbox's tokens, the CSP),
`LanePane.test.tsx` (the frame in each state, Reload, the words why, the four languages), `previewHost.test.ts` (the mock's address,
the stubbed shell, and that only a plain browser reads it), `preview.rs` (the shared table, and what the app's window may load),
and lib.rs's tests: every command the page may call, and twelve plugin commands, sent through Tauri's own check from a preview's
origin are refused and none runs, in Tauri's mock runtime with the app's own capabilities (`tauri`'s `test` feature, for tests
only), and the window's hook refuses another site in the main window and leaves the outpost's to its own.

### Where a lane works

Each lane works in a folder of its own: a git worktree of the developer's repository, on the lane's own branch, made from the
branch the developer's folder is on (`src-tauri/src/lane.rs`, planned in `code/laneBranch.ts`). The lane's chat session runs
its agent there, and everything that reads a lane reads it there: Kit's dial, the test runs, Rewind and Bring it back, the
main-moved note and what keeps running (`workDir` in `code/laneBranch.ts`). Several lanes work at once, none touching
another's files or the developer's folder.

- **Where the folders live.** `~/.manut/lanes/<project>/<words>`, or `<chosen folder>/<project>/<words>` when the person chose
  a folder in Settings › Worktrees (last bullet of this list): never inside the developer's folder or its `.git`. `<project>` is the repository folder's name as one plain word, `<words>` the branch's words after
  `kit/` (`kit/promptpay-qr` works in `~/.manut/lanes/web-app/promptpay-qr`), with `-2`, `-3` … when that name is on disk
  already. A session started in a folder inside the repository (`apps/web`) works in the same folder inside its worktree.
  The folders the app makes there are for this account only. git keeps its own note of each worktree in the repository
  (`.git/worktrees/<name>`), as it does for any.
- **Which are the app's.** Beside each folder the app makes, a record of it (`<words>.json`), written as a new file before
  git is asked: the folder, the repository, the developer's folder, the branch, the branch it was made from and the commit.
  The record always stays under `~/.manut/lanes`, which only the app writes, even for a lane made under a chosen folder: its
  `worktree` is then the chosen folder's, with the same last name as the record. Only a folder with such a record that git
  still lists as a linked worktree of the recorded repository (never the repository's own, first one) is ever removed; a
  record that names a folder with another last name, a relative path or one with `..` in it is no record. The app never
  runs `git worktree prune`, and `--force` only ever reaches a folder it made, after the person's yes. Nothing is written
  through a link: a link where a lanes' folder or a record would go is refused or passed over.
- **What comes along.** The committed tree only. The developer's uncommitted changes stay in their folder, and nothing git
  ignores (`node_modules`, build output, `.env`) is copied or linked: a link would let the lane's install write into the
  developer's folder, and a copy could be of other versions than the lane's lock file says. One named exception (item 72,
  `src-tauri/src/lane_config.rs`): the project's own agent settings that git does not hold, so the agent in the lane has the
  same MCP servers, skills, commands and local settings as in the project. See [MCP servers and skills](#mcp-servers-and-skills). No hook runs while a folder is made or
  removed (git's `core.hooksPath` points at a folder that is never made), so nothing a project sets up on checkout (an
  install, a generated file) happens by itself. The chat says it as the lane starts: where Kit works, how many of the
  developer's changed files did not come along, and that nothing is installed there yet. The app installs nothing; Kit may,
  and the dial asks first, as for any install.
- **When a folder goes.** When its session is closed (the chat is deleted), once its agent stopped, and Settings › Worktrees'
  "Remove the folder when its chat is deleted" is on (it is, by default), `lane_release` removes it only if nothing in it is
  changed or new, git is not partway through a rebase, merge, cherry-pick, revert or bisect there, every commit on its branch
  is on a remote (`git rev-list --count refs/heads/<branch> --not --remotes` is 0), and nothing git ignores in it may be the
  developer's own (item 86). `git worktree remove` takes ignored files without a word, so the folder's ignored files are listed
  first (`git ls-files --others --ignored --exclude-standard --directory`): only what a project rebuilds (inside a folder of
  `turn_files::REBUILT`, the list Rewind already leaves out: `node_modules`, `target`, `dist`, `build`, `.next`, `.venv` and the
  rest), the system's own files (`.DS_Store`, `Thumbs.db`, `desktop.ini`) and the agent settings item 72 copied in (and the
  `.gitignore` it writes in an agent folder it makes) may go with it. Anything else, a `.env.local` or a local database made
  in the lane, keeps the folder, and the kept list names the first of those files; Remove's panel names them as going too.
  The branch stays, and no force flag is ever passed: the removal is `git worktree remove <folder>`, which git itself refuses
  for a locked worktree or one holding files it will not take. A folder kept for commits on no remote says so in the kept
  list. A folder with submodules (a gitlink in its index, checked out or not, or a modules folder of its own) is always kept
  (item 90): the app reads nothing inside a submodule by itself (see "Git the app runs by itself"), so its uncommitted work
  and its commits are not counted, and an empty submodule folder can hold files git lists nowhere. With the switch off, every folder of a deleted chat is kept and listed. A folder with changes is kept and listed under the lanes
  as one of Kit's folders kept, for its project, which stays on the Code page for it even when no session is left there.
  Remove opens a panel that says how many changed files go with the folder; ticking Delete the branch too says how many
  commits on the branch are not on its base, or that it could not tell. A changed submodule is not one of those files (item
  90), and the kept list says when a folder has submodules; Remove never forces such a folder, so git's own refusal ("working
  trees containing submodules cannot be moved or removed", or its refusal of a folder with changes) stands and is shown, and the
  person removes it by hand. The press is the yes to exactly those numbers: when
  what is there differs, nothing is done and the panel shows the numbers there are now. A folder removed by hand takes only
  git's note of it and the record with it.
- **Settings › Worktrees** (item 73; `src/settings/WorktreesPage.tsx`, saved on this computer by `src/lib/worktrees.ts` and
  handed to the shell on each call). Five rows:
  - *Where lanes are made* (default: `~/.manut/lanes`). A folder picked with the system's chooser, checked by `lane_root_check`
    (`check_lanes_root`) when it is chosen and again each time a lane is made: refused inside any repository's work tree (a `.git`
    in it or above it, the home folder aside), when it is the disk's top, the home folder or `~/.manut`, when it is not an
    absolute path without `..`, and when a file cannot be made in it. A refusal is a code the page words (`root_in_checkout`,
    `root_too_broad`, `bad_root`, `root_unwritable`); a lane is then not made in another place, and the chat says so. Lanes
    already made stay where they are and are listed and removed as before.
  - *Start from the remote* (default off). On: the lane starts from the remote's latest commit of its base branch. The remote
    is the one the base tracks (`branch.<base>.remote` and `.merge`), else `origin` with the same branch name; `git fetch
    --no-tags --no-recurse-submodules --no-write-fetch-head --no-auto-maintenance <remote> +refs/heads/<b>:refs/remotes/<remote>/<b>`
    reads that one branch, ends in 10 seconds, and sets `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=true`, `GCM_INTERACTIVE=never` and
    (unless the person has their own ssh command) `ssh -o BatchMode=yes`, so nothing can wait for a password. The remote's
    commit is used only when the local branch is that commit or behind it (`git merge-base --is-ancestor`): a local branch with
    commits the remote lacks would lose them in the lane. The lane's first line says where it started: from `origin/main`, or why
    from the local branch (no remote, the remote did not answer, the folder is detached, the local branch is ahead or both moved,
    or the folder is not in the remote's commit). The fetch runs in the shell, off the page's thread, and only after the first
    message; the chat is open meanwhile.
  - *Branch prefix* (default `kit/`). Free text, checked on the page and in the shell: one or two lower case words of letters,
    numbers and single hyphens, each followed by `/` (`kit/`, `team/ana/`), at most 24 characters. A lane made under an earlier
    prefix keeps its name and is still listed and removed.
  - *Remove the folder when its chat is deleted* (default on), as above.
  - *Remove the folder when its pull request has merged* (default off). `lane_clean_merged` runs when the Code page opens a
    project and when the window is looked at again, at most once an hour for a project, never on a timer; it does nothing (and
    makes no call) when the project has no folder to look at. It needs `gh` or `glab` installed and signed in (`Tasks::status`);
    otherwise it says it cannot tell and does nothing. Per folder it asks `gh pr list --repo <r> --head <branch> --state merged
    --json headRefOid,mergedAt --limit 10` (GitLab: `glab mr list --repo <r> --source-branch <branch> --merged --output json
    --per-page 10`), and removes the folder only when a merged request exists, the branch's tip is in the default branch on the
    remote (fetched first, one branch) or, on GitHub, is exactly the commit that merged (what a squash merge leaves), and then
    `lane_release`'s checks pass: nothing changed or new, nothing ignored that may be the developer's, git not busy there, and
    no session still works in it. The branch
    stays. Each folder it leaves is listed with why (not merged, not in the default branch yet, changes of its own, ...).
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
  lane's folder (Show folder on a kept one; the session's own Show in Finder, Open in Terminal and Open in <editor> open its folder, and so does the lane's own Open in <editor>); it
  reaches the developer's folder only when they merge it or switch to it. While the lane's folder exists, git will not switch
  the developer's folder to the lane's branch (it is checked out in the lane's), and `git worktree list` lists the folder.
  Kit no longer sees the developer's uncommitted changes.
- **Lanes made before this change** (on the developer's folder, with `git checkout -b`) were never saved with their session,
  so after the update such a session comes back with no lane of its own and keeps working where it was, in the developer's
  folder; the app moves nothing. That folder may still be on the old lane's `kit/` branch; switching it back is the
  developer's to do.

### Source control

Settings › Source control (item 75, from T3 Code's Source control and issues page the owner sent; `src/settings/SourceControlPage.tsx`,
its choices kept on this computer by `src/lib/sourceControl.ts`). The page has three parts:

- **Version control** and **Source control providers.** Git with its version, and GitHub's CLI (`gh`) and GitLab's (`glab`), each
  installed or not, its version and who is signed in, by name only (`source_tools.rs`). Everything is read through the runners that
  already exist: `tasks::find` and `tasks::run_env` (no shell, nothing on stdin, a time limit), `--version`'s first line of which
  only the digits are kept, `Tasks::status` (signed in by `auth status`'s exit code alone), gh's accounts from `gh_me.rs` (`gh auth
  status --json hosts`: host and login), and for glab `glab api user`, of which only `username` is read. Nothing is installed or
  signed in from here: a missing or signed-out CLI says how, with its own login command in a terminal. Check again reads afresh,
  as coming back to the window does.
- **Automatically pull** (default off). When on, the Code page asks `source_pull` for the project it opens and when the window is
  looked at again, at most every fifteen minutes for a project, never on a timer. `git_pull.rs` brings the default branch up to
  date only when the folder is not a lane's; the repository's own config names no program for git to run and no other address to
  fetch from (see "Git the app runs by itself" below); git is not partway through a rebase, merge, cherry-pick, revert or bisect and holds
  no index lock; the checkout is on a branch that tracks a remote branch and both are, by name, the remote's default branch (where
  `<remote>/HEAD` points, else `main`, else `master`, as the merged clean-up reads it); the checkout has no submodules (item 90:
  what one holds is never read by itself, so the pull cannot tell whether it would move past work in one; a checkout with any
  says so and is pulled in a terminal); `git status --porcelain=v1 --untracked-files=all --ignore-submodules=all` lists nothing
  (ignored files do not count); and `git rev-list --count HEAD --not --remotes` is 0. Then it fetches that one branch exactly as Start from the remote does (`lane::fetch_branch`, ten seconds, no
  password) and moves the checkout only when its commit is an ancestor of the fetched one, with `git merge --ff-only
  --no-overwrite-ignore --no-autostash --no-verify-signatures --no-stat <commit>`: a fast-forward git refuses otherwise, never a merge commit, a rebase,
  a stash or a force; no hook runs. An ignored file does not count as a change, but it is never written over: git's default
  (`--overwrite-ignore`) would replace a person's ignored `.env` or `.mcp.json` with a tracked file an incoming commit adds at
  the same path, so the pull passes `--no-overwrite-ignore` and git's refusal is said as the folder having changes (item 86).
  A lane started from the remote cannot do this: its fetch moves only the remote-tracking branch, and its checkout is a new
  folder. The cleanliness is read again just before that one write. Kit's panel for the project says in one line what happened:
  how many commits came, or why nothing was done (changes, submodules, commits on no remote, busy, another branch, no upstream,
  could not fetch, both moved).
- **Default merge method** (default "The last one I chose", which starts as a merge commit) and **Remove agent credits when
  merging** (default off), for the asks below. The recognised credit lines are listed on the page as the code holds them.

**Git the app runs by itself** (item 86). A repository's `.git/config` can come from someone else (a zip a freelancer sent), and
git runs programs it names without asking: clean and smudge filters while it reads or checks out files, an ssh command, a
credential helper, a remote of the `ext::` kind, and `url.<base>.insteadOf` sends a fetch elsewhere. The work the app starts by
itself, never on a press (the automatic pull, the merged clean-up, a deleted chat's folder, the kept list's counts, the lane's
Diff and the main-moved note), first reads `git config --list --show-scope --includes -z` (or `--local` on a git before 2.26)
and does nothing while the repository's own scopes (`local`, `worktree`, and the files they include) name any of
`filter.<driver>.clean`, `.smudge` or `.process`, `core.sshCommand`, `core.gitProxy`, `core.askPass`,
`core.alternateRefsCommand`, `credential.helper` or `credential.<url>.helper`, `remote.<name>.uploadpack`, `.receivepack` or
`.vcs`, a `remote.<name>.url` or `.pushurl` of the `<transport>::<address>` form, or `url.<base>.insteadOf` or
`.pushInsteadOf` (`lane::risky_setting`). The pull says it in its one line with the setting's name (an address in it shown as
`*`), the clean-up says it where it says it could not tell, a folder of a deleted chat is kept with that reason, the kept list
reads no counts, and the Diff and the main-moved note fall back to what they show when they cannot read. The person's own global
and system settings are theirs and stay as they are. What the app's runs switch off instead, so it is not refused: hooks
(`core.hooksPath` pointed at a folder never made), `core.fsmonitor=false`, `--no-ext-diff --no-textconv` on every diff
(`diff.external`, `diff.<driver>.command` and `.textconv`), `--no-verify-signatures` on the pull's write (`merge.verifySignatures`
would run `gpg.program`), `protocol.ext.allow=never` on every automatic run, and a pager or an editor, which git starts only for a
terminal (`GIT_PAGER=cat` too on the Diff). A workflow's lane made by the clock is the app's own work too (item 114, see
Workflows). Work the person asked for by pressing something (a lane started, Run now, its fetch, a push
and a pull request after a Yes, Remove) runs git with their settings and the repository's, as the same git in a terminal would,
hooks and the file monitor aside: they chose to act on that project, and a refusal there would break a repository-local LFS or
deploy-key ssh setup the person relies on.

**Where a fetch goes and what it trusts** (item 114, third security review). A repository's own config could also send the
automatic pull's fetch, or the merged clean-up's, through a proxy of someone else's choosing, which answers 401 and is handed
the person's git login (`git_pull.rs` shows it with git 2.54, a stand-in proxy on the Mac and a made-up credential helper).
Read family by family from `git help config`, the repository's own scopes now also stop automatic work at:

- `http.*` and `http.<url>.*`, every key: a proxy with its authentication and certificates, a name resolved to another
  address (`curloptResolve`), redirects, which certificates and keys are trusted (`sslVerify`, `sslCAInfo`, `sslCAPath`,
  `pinnedPubkey`, `sslBackend`), what is sent (`sslCert`, `sslKey`, `extraHeader`, `cookieFile`, `saveCookies`, `emptyAuth`,
  `proactiveAuth`, `delegation`, `userAgent`). Ten keys that only pace a transfer do not stop it (`postBuffer`,
  `lowSpeedLimit`, `lowSpeedTime`, `maxRequests`, `minSessions`, `version`, the three `keepAlive` keys and `noEPSV`): a
  repository often has `http.postBuffer` set for a large push, and none of them names an address, a program, a file, a
  header, a credential or a certificate. Any other `http` key stops it, a new one git adds included.
- `remote.<name>.proxy` and `.proxyAuthMethod`, beside `.uploadpack`, `.receivepack`, `.vcs` and a `<transport>::` address.
  The remote's own plain address stays: the fetch goes to the remote the repository names, as in a terminal. `.fetch` is not
  read: the app's fetch now passes an empty `--refmap=`, since a configured refspec otherwise writes the fetched commit onto
  another ref too (git's "opportunistic" update moved one of the person's own branches in a test). `.tagOpt`, `.prune`,
  `.pruneTags`, `.mirror`, `.push`, `.serverOption`, `.followRemoteHEAD`, `.promisor` and `.partialCloneFilter` name no
  address and run nothing (a promisor's lazy fetch goes to that same remote).
- `url.<base>.*`: both its keys, as before.
- `credential.*` and `credential.<url>.*`, every key: a helper is a program, and the rest says what is sent and how it is
  protected (`username`, `useHttpPath`, `protectProtocol`, `sanitizePrompt`, `interactive`).
- `ssh.variant`: how git passes options to the ssh program.
- `protocol.allow`, `protocol.<name>.allow` and `protocol.version`: which transports git takes (every automatic run still
  passes `-c protocol.ext.allow=never`).
- `fetch.bundleURI` and `transfer.bundleURI`: a download from another address first, or from one the server names. The rest
  of `fetch.*` and `transfer.*` only tune a fetch (`prune`, `pruneTags`, `fsckObjects`, `unpackLimit`, `writeCommitGraph`,
  `parallel`, `output`, `negotiationAlgorithm`, `hideRefs`, `credentialsInUrl`) or are overridden on the command line
  (`fetch.recurseSubmodules` by `--no-recurse-submodules`; with the explicit refspec, pruning reaches only that one branch,
  checked with git 2.54).
- `core.protectHFS` and `core.protectNTFS`: turned off in a repository, a checkout could write into `.git` through a name
  the disk reads as the same. The rest of `core.*`: `sshCommand`, `gitProxy`, `askPass` and `alternateRefsCommand` as
  before; `hooksPath` and `fsmonitor` overridden by `-c`; `editor` and `pager` start only for a terminal; `worktree` only says
  where the work tree is, and git reads that folder's own repository there; the others are about the disk and the index.
- `submodule.<name>.update` naming a command (`!`). The rest of `submodule.*` acts only inside a submodule, or when one is
  cloned or updated, which the app never does by itself (item 90).
- `pull.*` is not read by anything the app runs: it never runs `git pull`, but a fetch and `git merge --ff-only`, whose
  settings are switched off on its command line as above (a merge driver runs only for a real merge, never a fast-forward).

What a person sees: a project with any of these in its own `.git/config` is not pulled by itself and its merged lanes are not
cleaned up by themselves, and the line names the setting (an address in a subsection shown as `*`). The person's own global
and system settings, their proxy among them, stay theirs, and a pull in a terminal works as before.

**Includes, and the folder git runs in** (item 118, fourth security review). A repository's config can include another file
of settings, and `includeIf` includes it only where a condition holds: on a branch with a given name (`onbranch:`), in a git
folder at a given place (`gitdir:`, `gitdir/i:`), or where a remote has a given address (`hasconfig:remote.*.url:`). git lists
only the include's own key wherever the condition does not hold, so a file that defined a filter only on a lane's branch, or
only in a lane's git folder, was invisible to the read made in the developer's folder, and a lane made with nobody there
then ran it. Now:

- Every `include.*` and `includeIf.*` key in the repository's own scopes stops automatic work, whatever its condition, named
  `include.path` or `includeif.*.path` (a condition can hold an address, so it is shown as `*`). The app cannot read what the
  included file would say in every folder git runs in. A submodule's own config is read the same way. The person's own
  global and system includes stay theirs.
- A lane made with nobody there is added with nothing checked out (`git worktree add --no-checkout`), its config is read
  again from inside the new folder, where the lane's branch and git folder are what a condition tests and anything written
  to the shared config since the first read shows, and only then are its files written, by the command `git worktree add`
  runs for its own checkout (`git reset --hard --no-recurse-submodules --quiet` in the new, empty folder; seen with
  `GIT_TRACE` on git 2.54). If that read finds anything, the folder and its branch are taken back (`git worktree remove
  --force`, which skips git's own clean check and so runs nothing in the folder, then `git branch -D`), its record goes, and
  the run is skipped with the setting, as before.
- Every other automatic path was read for a git that runs in a folder other than the one its config was read in. The
  merged clean-up and a deleted chat's clean-up read the lane's folder, and they remove it by running git in the
  repository's own git folder (`git worktree remove`, `git branch`), where git reads the developer's folder's own worktree
  config (`extensions.worktreeConfig`) and the lane's read does not: that git folder's config is now read too
  (`Git::lane_config_risk`). The lane's Diff lists worktrees there, so it reads it too. The automatic pull runs every
  command in the folder it read, on the same branch, but its fetch takes up to ten seconds and the config is shared with
  every lane's agent, so the config is read again just before its one write, beside the folder's cleanliness. The kept
  list reads each folder it counts in (the developer's, then each lane's), and the main-moved note reads the folder it
  diffs in, so neither changed. Start from the remote fetches in the developer's folder, which the first read covers.

What a person sees: a project whose own config has any include is not pulled by itself, its merged lanes are not cleaned up,
its Diff falls back, and a workflow by the clock is skipped, each with the include named, in the words the other settings
already use.

**git-lfs, and the other helpers a repository's config can aim** (item 118). The person's own global settings stay theirs,
but some programs a person commonly has set up globally then read the repository's settings as well. git-lfs is one:
`git lfs install` puts its filter in the person's global config, and git-lfs reads its settings from every file `git config
-l` reads, the repository's included, and also from a `.lfsconfig` in the work tree, else the index, else HEAD, from which
it takes only a short list of keys (git-lfs-config(5), read from git-lfs's own manual; git-lfs is not installed on the Mac
this was built on, so nothing was run). Some of its keys name a program (`lfs.customtransfer.<name>.path` and `.args`, the
latter expanded by a shell, `lfs.standalonetransferagent`, `lfs.extension.<name>.clean` and `.smudge`), some another
address (`lfs.url`, `lfs.pushurl`, `lfs.<url>.access`, `remote.<name>.lfsurl` and `.lfspushurl`). Now:

- Every `lfs.*` key in the repository's own scopes, and `remote.<name>.lfsurl` and `.lfspushurl`, stops automatic work, a
  subsection shown as `*` (`lfs.<url>.access` holds an address).
- `.lfsconfig` is read from all three places git-lfs reads it, with the same rule, and named `.lfsconfig:<setting>`: the
  work tree's file (a link, a file over 64 KB or one git cannot read is `.lfsconfig:?`), the index's and HEAD's
  (`git config --blob`). Every key in it counts, not only the ones git-lfs takes today, since an older git-lfs took more.
  The automatic pull also reads the `.lfsconfig` of the commit it would move to before its one write, and a lane made with
  nobody there reads its own commit's from inside its new folder, so a lane started from the remote's newest commit is read
  too.
- Every git the app starts by itself runs with `GIT_LFS_SKIP_SMUDGE=1`, so the person's LFS filter downloads nothing for a
  checkout the app makes: it writes the pointer file as it is. One consequence a person can see: after an automatic pull that
  brought a changed LFS file, that file is a pointer until they run `git lfs pull` (git counts the folder as clean, so nothing
  is lost). A lane the person starts, and anything after a press, downloads as in a terminal.

The rest of the class, read in `git help config` (git 2.54) for a section whose keys a commonly installed helper or git itself
reads, that a repository's config can aim, and whether any automatic run of the app reaches it:

- `gc.*` and `maintenance.*`: reached. `git merge` runs `git maintenance run --auto` after the pull's fast-forward (seen with
  `GIT_TRACE`), and the repository's settings steer what it prunes and when (its hook, `pre-auto-gc`, was already off). Every
  automatic run now passes `-c maintenance.auto=false -c gc.auto=0`, as hooks are switched off, rather than refusing a
  repository that tunes them: the app's own work never needs housekeeping, and the person's next git in a terminal does it.
- `gpg.*` (`gpg.program`, `gpg.ssh.program`, `gpg.ssh.defaultKeyCommand`, `gpg.x509.program`): read only to sign or verify. No
  automatic run makes a commit or a tag, `git log` runs only for a draft the person asked for, and the pull's write passes
  `--no-verify-signatures`. Not reached.
- `diff.<driver>.*` and `diff.external`: every automatic diff passes `--no-ext-diff --no-textconv`, `git status` uses no diff
  driver, and the pull's write passes `--no-stat`. Not reached (a submodule's are refused, see "Submodules").
- `merge.<driver>.*`: a merge driver runs only for a real merge; the pull is `--ff-only`. Not reached.
- `mergetool.*`, `difftool.*`, `sendemail.*`, `browser.*`, `web.*`, `man.*`, `instaweb.*`, `interactive.diffFilter`: read only by
  `git mergetool`, `git difftool`, `git send-email`, `git web--browse`, `git help`, `git instaweb` and `git add -p`, which
  nothing automatic runs. Not reached.
- `pager.*` and `core.pager`: a pager starts only when git's output is a terminal; the app's runs read it through a pipe (a
  pager named by a repository did not start for `git log` through a pipe, checked). Not reached.
- `core.editor` and `sequence.editor`: an editor starts only for a message or a list to edit; no automatic command needs one
  (fetch, a fast-forward, a checkout, removing a worktree, deleting a branch, status, diff and reads). Not reached.
- `alias.*`: the app runs git's own commands by name, and an alias that hides one is ignored (`git help config`). Not reached.
- `trailer.<token>.command` and `.cmd`: run by `git interpret-trailers` and `git commit --trailer`, which nothing automatic
  runs. Not reached.
- `uploadpack.*`: read by the side that sends a fetch, the remote's; `uploadpack.packObjectsHook`, the one that runs a program,
  is taken only from the person's own (protected) config. The repository's `remote.<name>.uploadpack` is refused as before.
  Not reached.
- `receive.*`: read by the side a push goes to; nothing automatic pushes. Not reached.
- `core.hooksPath` and `core.fsmonitor`: overridden by `-c` on every run, as before.
- `credential.*`, `http.*`, `url.*`, `ssh.*`, `core.sshCommand` and the rest of item 114's families: refused, as before.
- Other filters a person sets up: git-crypt and git-annex write their filters into the repository's own config, which is
  refused (`filter.<driver>.*`). Not confirmed: git-annex's own repository settings (`annex.*`), since git-annex is not
  installed here either; a git-annex filter in the person's global config would read them, as git-lfs reads `lfs.*`.

**Submodules** (item 90). A git that goes into a submodule reads that submodule's own config (`.git/modules/<name>/config`,
nested ones too) and attributes, which none of the above reached, so a folder someone sent with a submodule whose config names a
clean filter ran it within a minute of being opened. Two guards now:

- The app's own runs never go into a submodule. `git status` and every diff pass `--ignore-submodules=all` (a diff against the
  work tree, and a status, otherwise run `status` inside each submodule), the diffs also `--submodule=short` (never
  `diff.submodule`'s `log` or `diff` forms, which read or diff inside one), the fetch `--no-recurse-submodules`, and every
  automatic run `-c submodule.recurse=false -c diff.ignoreSubmodules=all` for anything that does not say it itself (`git help
  status`, `git help diff`, `git help config`; `git merge --ff-only` does not recurse on its own, checked with git 2.54).
  `ls-files`, `rev-parse`, `rev-list`, `merge-base`, `log` and `worktree list` never go into one.
- Before any automatic work, every submodule's own config is read too (`lane::config_risk_by`): each git folder under the work
  tree's modules folder (`git rev-parse --git-path modules`; a lane has its own), nested ones and names with `/`, walked without
  following a link, and the git folder of each submodule checked out in the work tree that is not under it (`<path>/.git`, a
  folder, or a file whose `gitdir:` points anywhere), each read as git reads it there (`git --git-dir=<folder> config --list
  --show-scope --includes -z`, so `includeIf` is matched against the submodule). The same settings stop it as above, and a diff
  driver's program too (`diff.external`, `diff.<driver>.command` and `.textconv`), since `--no-ext-diff --no-textconv` does not
  reach a diff git runs inside a submodule. It is named `modules/<name>:<setting>`. A link, a config git cannot read (the
  repository's own too), more than 100 such folders or deeper than 8 is read as `?` and stops the work the same way. Attributes
  are not read: a filter or diff driver named in `.gitattributes`, `info/attributes` or `core.attributesFile` runs nothing
  unless a config defines its program, and every config git reads for the repository and its submodules is read here (the
  person's own global and system settings aside, as above).

What a person sees changes a little: a changed submodule is no longer counted as a change in a lane's counts, its Diff or the
main-moved note. Nothing is removed or pulled past because of that: a folder with submodules is kept by every clean-up
(`submodules`), Remove never forces it, the automatic pull stops at a checkout with any, and the kept list says so. Elsewhere in
the same class: a `.git` file that points at another folder, and a bare repository committed inside a project, are read exactly
as git reads them from the same folder, so the same settings stop the work; `include.path` and `includeIf` are read with
`--includes`, and since item 118 any include stops the work itself (see "Includes, and the folder git runs in"); hooks and the file monitor are switched off by `-c`, which git passes on to every git it starts, a submodule's
included; the variables that would send git to another repository's files or objects (`GIT_DIR`, `GIT_WORK_TREE`,
`GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_COMMON_DIR`, `GIT_NAMESPACE`) are taken out
of what git inherits; an alternates file names only where objects are read and runs nothing; and git's own `safe.directory`
and `safe.bareRepository` are left as the person set them (the app never widens them).

**Put up for review** (`code/Review.tsx`, under a lane's row and at the top of its pane, for a lane with a folder and a branch of
its own and no open pull request yet). The link opens a draft: a title (the one commit's subject, else the lane's title) and a
description (the commits' subjects), both the person's to change. Ask has the shell read the lane now (`review.rs` `ask_open`):
the app's own folder, on its own branch, with commits the base on the remote lacks, a GitHub or GitLab remote that is not a
mirror, and that CLI installed and signed in. Otherwise it says why and asks nothing. It writes down the exact plan, `git -c
push.followTags=false push --recurse-submodules=no <remote> refs/heads/<branch>:refs/heads/<branch>` (no `+`, no flag that forces,
deletes, mirrors or sends tags) and `gh pr create --repo <r> --base <base> --head <branch> --title=<title> --body=<body>` (`glab
mr create --repo <r> --source-branch <branch> --target-branch <base> --title=<title> --description=<body> --yes --push=false
--remove-source-branch=false`), and answers the ask: the repository, the branch with its commits and remote, the base, and the
title and body in boxes, exactly as they will be sent, with how many uncommitted files stay behind. Push and open, or Not now.

**Merge** (the same place, once the lane's pull request is open and not a draft). The method starts from the setting and can be
changed; Ask has the shell read the pull request (`gh pr view --json ...` with `isCrossRepository`, `headRepository` and
`headRepositoryOwner`, `glab mr view --output json`) and ask only when it is open, not a draft, made from the lane's branch in
this very repository, its head commit is the lane's own tip, and it can merge now (item 86). A fork can open a pull request on a
branch named like a lane's (`kit/<words>` is easy to guess and public once pushed), so the branch's name is never enough:
GitHub's `isCrossRepository` must be false and its head repository (`nameWithOwner`, else the owner's login and the name) the
repository the pull request's own address names; GitLab's `source_project_id` must equal its `target_project_id` (GitLab's API
says they differ only for a fork; glab is not on the Mac this was built on, so its answer is read as the API's object, as
before). A request from another repository is refused (`other_repo`). Its head commit must be the lane's branch tip on this Mac
and the tip this Mac last pushed (`refs/remotes/<remote>/<branch>`): a lane with commits the request does not hold
(`lane_ahead`), a request holding commits the lane does not (`pull_ahead`) and a tip this Mac has no record of pushing
(`not_pushed`) each say why on the card and ask nothing. The ask shows where the request comes from (`<branch> of <owner/repo>
into <base>`) and its head commit's short id beside its title. Then: GitHub's `mergeable` is `MERGEABLE` and `mergeStateStatus` is
`CLEAN`, `HAS_HOOKS` or `UNSTABLE` (`BLOCKED` is refused, since gh would turn on auto-merge for it), GitLab's
`detailed_merge_status` is `mergeable`. The ask names the pull request, the method and the message exactly as sent: GitHub's own
defaults (`Merge pull request #<n> from <owner>/<branch>` with the title and description; `<title> (#<n>)` with each commit's
message for a squash), GitLab's (`Merge branch '<branch>' into '<base>'` with the title, description and request; the title and
description for a squash, sent as both `--squash-message` and `--message`), and for a rebase none, since it makes no message
and changes no commit's. The merge runs as `gh pr merge <n> --repo <r> --merge|--squash|--rebase --match-head-commit <sha>
[--subject=<s> --body=<b>]` (`glab mr merge <n> --repo <r> --yes --auto-merge=false [--squash] [--rebase] [--sha <sha>]
[--message=<m>] [--squash-message=<m>]`): never `--auto`, `--admin` or a branch deletion; the app never deletes the remote branch
(a repository's own "delete head branches" setting on GitHub is GitHub's). It is always asked; no setting skips it. After a merge,
item 73's clean-up may remove the lane's folder as it already does. With Remove agent credits on, the proposed message has the
recognised lines taken out before the ask shows it (`credits.rs`, T3 Code's `removeAgentCredits`): a `Co-authored-by:` for an agent's
address (`noreply@anthropic.com`, `noreply@openai.com`, ...; GitHub's `noreply@github.com` only as Copilot) and a line that is only
"Generated with" or "Generated by" a named agent; every human co-author, a fenced or indented example and a quote stay. A message
of credits alone becomes the title, so the host never writes its own with them back in. Commits that exist are never rewritten.

**How a write is tied to the ask, and runs once.** The shell's ask (`review.rs`, a `Ledger` of this run's asks) holds the plan; the
page holds none. The page opens the ask as an approval-core request (`code/reviewAsk.ts`: kind `public_post`, options yes this once
or no, the ask as its detail) and the person's answer settles it there, through approval-core's rules, once. Only a request
approval-core settled reaches `review_settle`, which sends the ask's id and the answer and nothing else. The ledger takes the ask
out of waiting under its lock before anything runs, so a second answer is `already_decided`; an ask taken back (the panel closed,
the draft or the method changed) is `withdrawn`; one older than fifteen minutes is `expired`; an id this run never made is
`not_found`. A No runs nothing. A Yes runs the plan written at ask time, after reading again that the branch is still the commit
shown (open) or that the pull request is still this repository's own branch, open, mergeable, at the head shown and into the base
shown, and the lane still at that commit (merge); otherwise nothing runs (`changed`). Neither `gh pr merge` nor `glab mr merge` can
bind the base itself, so a retarget in the moment between that read and the merge is the one change the app cannot see. The
function that runs a plan takes a proof only `settle` can make, and `lib.rs` names only the asks, `settle` and `withdraw`
(`the_page_reaches_the_writes_only_through_a_settled_ask`). Tasks (`tasks.rs`) stays the read-only reader its tests say it is.

The tests run against temporary repositories, with a bare one behind a `https://github.com/o/r.git` address that git is told, in
that repository only, to rewrite to the bare folder, and stand-ins for `gh` and `glab` that record what they were asked: nothing
reaches a real remote. `glab` is not installed on the Mac this was built on, so its argv follows its documentation and is
covered by the stand-in only.

### Pull requests across projects (item 100)

**Tasks › Pull requests** (`tasks/PullsView.tsx`, `tasks/board.ts`, `src-tauri/src/pulls.rs`) is the Tasks page's third scope. It
lists the open pull / merge requests of every project the Code page lists (each folder's remote, read once per repository) under
grey bands by readiness: ready (approved, or no review asked, with green checks and no conflict), checks running, review needed,
changes asked, checks failing, conflicts, drafts; the newest change first in each. A row names its repository and number, who
opened it, when it changed, its checks and review, and whether it is a lane's or a chat's. The shell reads `gh pr list --json
...,reviewDecision,mergeable,baseRefName` and `glab mr list --output json` (`detailed_merge_status`, `has_conflicts`), masked as
Tasks masks. A row opens the request in the app: title, description as plain text, checks, at most 300 changed files with their
counts (`gh pr view --json files,additions,deletions,changedFiles`; GitLab's `changes_count` alone), Open on GitHub, and Merge.

**Merge from the list is the lane's ask.** A lane's request goes to `review_ask_merge` with the lane's folder, as the lane's own
Merge does. Any other goes to `review_ask_merge_pull` (`review.rs` `ask_merge_pull`) with the project's folder: the folder's
remote must name the request's repository (`not_this_project`), the branch must be that repository's own (`other_repo`; the
detail offers no Merge for a fork's request), a lane folder of the app's on that branch sends it to the lane's ask, and the rest
is the lane's ask without a lane's tip: able to merge now, a method GitHub says the repository allows (`gh repo view --json
mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed`; `method_not_allowed`), the message exactly as sent, the merge bound to
the head commit shown and the request read again before it runs. Same `Plan::Merge`, same `settle`, same approval-core request.

**A chat's own pull request** (`code/chatPull.ts`). When a Claude Code or Codex chat ends a command the dial reads as a push with
`gh pr create` in it, the last github.com pull request address in its output is read, the chat's folder's remote must name that
repository, and one `gh pr view` must say the branch is that repository's own. Since item 120 that branch must also be the
chat's own (a lane's own branch, else the one its folder had when it was read), since the agent writes the output and an
`echo` beside the command could name a colleague's request, and a `gh pr create --dry-run`, which makes none, links nothing.
The chat's header then names the request, the request's row names the chat, and the chat's Lanes row shows it as a lane's
row does. Of this run; nothing is written.
Since item
100b the dial reads `glab mr create` as a push too (`kit.say.mr`, "Opens a merge request."; with an address among its words, and
for every other glab command, it is a program the dial has not read), and a merge request address on a host with `gitlab` among
its names (`https://gitlab.com/<group>/<project>/-/merge_requests/<n>`; glab prints it last, alone off a terminal) is linked by
the same checks, the view being `glab mr view`.

**GitLab's merge methods** (item 100b, `pulls.rs` `gl_methods_argv`, `parse_gl_methods`). The list's Merge step and
`ask_merge_pull` read the project with `glab api --method GET projects/<group%2Fproject>` and offer: a merge unless its
`squash_option` is `always`; a squash unless it is `never`; a rebase only when its `merge_method` is `rebase_merge` or `ff`, the two
GitLab's merge methods page offers a rebase for. Anything else is not read and all three are offered, for GitLab to refuse. glab is
not on this Mac (26 Nov 2026), so the flags are from GitLab's pages for `glab api` and `glab mr merge`, and the answer is read as
the Projects API's object. A lane's own Merge step is unchanged and still offers all three, as for GitHub.

**Other hosts, read only** (item 100b, `src-tauri/src/pulls_other.rs`, `tasks/board.ts`). A project whose remote is on neither
GitHub nor GitLab is asked of the other hosts' reader, which reads the folder's remote from its git config and answers only when
that host's CLI is installed; the page sends only the folder. Its open requests join the same bands, each row naming its host and
offering only Open on <host> (no detail, no Merge, nothing written):

- Azure DevOps (`https://dev.azure.com/<org>/<project>/_git/<repo>`, its `ssh.dev.azure.com:v3/...` form, and the older
  `<org>.visualstudio.com`) through `az repos pr list --organization ... --project ... --repository ... --status active --top 51
  --output json --detect false`, with `AZURE_EXTENSION_USE_DYNAMIC_INSTALL=no` so the CLI installs no extension by itself. The
  review is read from the reviewers' votes, a conflict from `mergeStatus`; the list carries no checks, so none are shown, and a
  request's address is made from the organisation, project, repository and id.
- Gitea and Forgejo through Gitea's own CLI, `gt` (it replaced the archived `tea`): `gt auth status --json=host --no-input` names
  the servers it is signed in to, at most once a minute, and a remote on one of them (https with the server's base path, or ssh
  to its host) is listed with `gt pr list --host <server> --repo <owner>/<name> --state open --limit 51 --json=<fields>
  --no-input`. Whether `gt` serves a Forgejo server is not confirmed; one it is signed in to is listed when its answer reads.
- Bitbucket is not offered: Atlassian's own CLIs are `acli`, which has no Bitbucket commands, and `twg` (Teamwork Graph), whose
  documented pages name a pull request query but no output a reader here could rely on; the other Bitbucket CLIs are not
  Atlassian's.

`az` and `gt` were not on this Mac on 26 Nov 2026: the flags are from Azure CLI's reference and configuration pages and `gt`'s
manual pages, and the tests read made-up answers in the documented shapes (`tasks_fixtures/az-pr-list.json`, `gt-pr-list.json`).
A host whose CLI is not here shows nothing and runs nothing; GitHub's and GitLab's projects are never asked of these CLIs.

**Watching costs little.** The page reads the lists once when shown, then at most once a minute while shown and in front, never
while hidden. The shell gives a list read within 55 seconds again, and before reading a GitHub list again asks `gh api --method
GET --include -H 'If-None-Match: <ETag>' repos/<r>/pulls?state=open&per_page=51`: a 304 gives the last list again and costs no
rate limit. The GraphQL list is read only when GitHub says the list changed, a check was still running, or ten minutes passed.

**A project's own icon** (item 100b, `code/ProjectIcon.tsx`, `src-tauri/src/project_icon.rs`). A project's folder header on the
Code page (TERMINALS) and Kit's band show the picture the folder keeps at the first of `public/favicon.svg`, `favicon.svg`,
`public/favicon.ico`, `favicon.ico`, `app/icon.png`, `app/favicon.ico`, `src/app/icon.png`, `assets/icon.png`,
`.github/logo.png`. Only the shell reads it: the folder must be absolute with no `.` or `..` part, every folder on the way and the
file itself are read with `symlink_metadata` and must not be a link (the file is opened with `O_NOFOLLOW` and its real path must
be inside the folder's), at most 64 KiB, and only a picture (an SVG with an `<svg` element, a PNG or an ICO by their first
bytes). It answers a `data:` address of that type, kept by path, size and modified time. The page draws it only as an `<img>`
(an SVG drawn as an image runs no script and loads no link) and draws nothing for any other address. Without one a folder
header keeps its folder glyph and Kit's band its name alone, as before. The side menu and the palette list no projects today, so
neither has a row to draw it on.

**A new project** (item 100b, `code/NewProject.tsx`, `src-tauri/src/new_project.rs`). New project in the Code page's top bar opens
a panel at the top of the column: a folder path (starting at `~/`, with Choose to pick one in the system's dialog) and Make the
project. The shell takes only an absolute path with no `.` or `..` part whose nearest existing folder's real path is inside the
person's home folder (not the home folder itself), refuses a path that is a link, a file, or a folder with anything in it (hidden
files count), makes the folder, checks its real path once more, and runs `git init --quiet --template=` through `lane::Git` (no
hook can run; an empty template copies no sample hook and no exclude file, whatever `init.templateDir` says). The page lists the
folder at once (`listFolder`, what New folder… does). That writes only on this computer.

**Make it on GitHub too** is offered beside what was made, and is the third write behind review.rs's one ask (`ask_repo`): the
shell checks the folder (in home, a repository's own top whose `.git` is a real folder, no `origin` yet), the name (`name` or
`owner/name`, letters, digits, `.`, `_`, `-`) and that gh is here and signed in, writes down `gh repo create <name> --private
--source <folder> --remote origin` (`--public` only when the person picked "Public: anyone on the internet can see it and copy
it.") and answers the ask with that line (`plan`), which the page shows whole. The page opens it in approval-core; a Yes reaches
`review_settle` by its id alone, the folder is read again (still a repository with no `origin`, else `changed`), and the line runs
once. Nothing is pushed: the argv has no `--push`, no step here pushes, and none is offered; the project's first push is the
person's, and a lane's Put up for review asks for it as always.

### MCP servers and skills

What a person already has works wherever an agent runs here (item 72). Chats, terminals and Buddy start the agent with the
app's whole environment and the person's real home, so Claude Code and Codex load their own MCP servers, skills, plugins and
settings as in a terminal. Four places needed more, and each changes only what an agent can see: every tool a server gives
still goes through the asks (How an ask is read, Kit's dial, Buddy's card).

- **A lane** (`lane_config.rs`). When a lane's folder is made, the files below that git does not track in the developer's
  folder (untracked or ignored), at the repository's top and in each folder down to the session's, are copied into the lane
  at the same paths: Claude Code's `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, `.claude/settings.json`,
  `.claude/settings.local.json`, `.claude/skills`, `commands`, `agents`, `output-styles`, `rules`, `workflows`; Codex's
  `AGENTS.md`, `AGENTS.override.md`, `.codex/config.toml`, `.agents/skills`. Names from each CLI's own documentation; nothing
  else git ignores comes along. Copied, never linked: the lane's agent writes its own local settings (an "always allow"), and
  a link would carry that into the developer's folder. A copy stays only when git ignores it in the lane: by the lane's own
  rules (the committed `.gitignore` files, the repository's `info/exclude`, the person's global excludes, where Claude Code
  puts `**/.claude/settings.local.json`), or because it is in an agent folder (`.claude`, `.codex`, `.agents`) the lane did not
  have, which the app makes with a `.gitignore` of `*` that ignores itself too. A copy git would still list as new is taken
  back at once. So a copy (an `.mcp.json` can hold a token) is never committed by `git add -A`, never kept in a turn's snapshot
  (which leaves out what git ignores), never keeps a clean-up from removing the folder, and goes with the folder. Links, files
  over 1 MiB and more than 200 files stay behind too. The lane's first line says how many came along and how many stayed and
  why; a file that came along is not counted among the changed files that did not. Since item 89 a chat's Claude Code reads
  none of the project's or the lane's own copies (see [What a project's own files cannot do](#what-a-projects-own-files-cannot-do)):
  they are there for a terminal opened in the lane, which asks Claude Code's own trust question, and for Codex. Copies are made for this account only
  (0600), and a change to a copy stays in the lane. Claude Code itself also reads some of the developer's own from a worktree
  (local settings at the main checkout's root, untracked skills, agents and commands when the worktree has none, the folder's
  local-scope MCP servers; checked on this Mac with Claude Code 2.1.332, `claude mcp list` in a `git worktree add` folder and
  a throwaway `CLAUDE_CONFIG_DIR`); the copies are for what it does not (an untracked `.mcp.json`), for Codex, and for Windows,
  where it keeps local settings with the worktree.
- **An added account** (`accounts.rs`, `share` and `prepare`). Before a session of Claude Code or Codex starts as an added
  account, the account's home gets links to the person's own home (the home folder set on Settings › Providers, else the
  CLI's default) for an allow-list of configuration: Codex's `AGENTS.md`, `AGENTS.override.md`, `skills`, `prompts`,
  `plugins`; Claude Code's `skills`,
  `commands`, `agents`, `output-styles`, `rules`, `workflows`, `plugins`, `CLAUDE.md`. An entry the account has of its own
  stays its own, a link elsewhere is left alone, and nothing is written in the person's home. Claude Code's `settings.json` is
  a copy without `env` and the keys its settings reference lists under Authentication and providers (`apiKeyHelper`,
  `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`, `forceLoginMethod`, `forceLoginOrgUUID`,
  `forceLoginGatewayUrl`, `enforceAnthropicSignIn`, `allowedProviders`, `otelHeadersHelper`), written again on each start
  while the account has not changed it (a hash beside it, `.manut-settings-copy`). Codex's `config.toml` (settings and MCP
  servers) is the same kind of copy (`.manut-config-copy`), since the security review of 25 Nov 2026: it used to be linked
  whole, and it can hold a provider's key or headers and an MCP server's tokens, so the added account could use the
  person's own key. The copy leaves out, wherever they sit (a provider, an MCP server, a profile, OpenTelemetry's
  exporters, the network proxy, an agent's role), every key Codex's configuration reference and its `rust-v0.169.0` schema
  name as holding a credential (`experimental_bearer_token`, `http_headers`, `query_params`, `headers`, `env`,
  `client_secret`, `oauth` and the rest of `CODEX_LOGIN_KEYS`), naming where one is read (`env_key`, `env_http_headers`,
  `bearer_token_env_var`, `credential_file`, `config_file`...) or running a command that prints one (`auth`,
  `gateway_oauth`, `aws`, `http_headers_helper`), and the tables `mcp_enterprise_managed_auth` and
  `shell_environment_policy.set`; the model, providers' addresses, the MCP servers themselves and project trust stay. An
  earlier version's link is replaced by the copy; the copy keeps no comments; a key pasted into an MCP server's `command`
  or `args` is not recognised. Never shared: `auth.json`, `auth.lock`,
  `.credentials.json`, `.claude.json`. On macOS Claude Code keeps an account's sign-in in the keychain under its config folder,
  so the shared files carry none. Left as before: Claude Code's servers added with `claude mcp add` (user scope, and a folder's
  local scope) live in its `.claude.json` beside the account's own details, and Claude Code rewrites that file while it runs,
  so no part of it is split off; Grok, pi and oh-my-pi accounts; and every added account on Windows, where a link needs
  rights a person rarely has.
- **An ACP agent** (`acp_mcp.rs`). Each ACP agent reads its own MCP configuration itself. It is now also handed, at
  `session/new`, `session/load` and `session/resume`, the project's `.mcp.json` servers that Claude Code would connect in
  that folder: the folder trusted in Claude Code's own `.claude.json` (`projects["<root>"].hasTrustDialogAccepted`, the
  root being the developer's folder for a lane), the server approved by `enabledMcpjsonServers` or
  `enableAllProjectMcpServers` in the person's user settings, the root's `.claude/settings.local.json` while git does not
  track it, or the folder's entry, and not in `disabledMcpjsonServers`. A repository's committed settings never approve its
  own servers, as in Claude Code. In a lane (item 89) the approval is of the entry, not the name: a server is handed on only
  when its whole entry in the lane, as canonical JSON (keys sorted, `${VAR}`s as written), has the same SHA-256 digest as the
  entry of that name in the developer's folder at the same place (`acp_mcp::entry_digest`), the one the person approved. A
  lane's `.mcp.json` is the lane's own file, which its agent can change, so another command, argument, variable, address,
  header or kind under an approved name, or a name the developer's folder does not have, starts nothing, and the chat says
  "Not started in this lane: <names>" with why (`session.note` `mcp_differs`, names only). A session in the developer's own
  folder is held to the entries there, as Claude Code is. Item 114: an entry that is the approved one can still run the
  LANE's files, since the agent starts its servers in the lane's folder: `node ./mcp/server.js` named the developer's script
  where the person approved it and names the lane's copy here, which the lane's agent can change. Resolving such a path
  against the developer's folder was not chosen: the server would still start in the lane's folder, and what a program
  finds there by itself (a local package, a project file, a module path) would still be the lane's. So in a lane a stdio
  server is not started (`acp_mcp::runs_the_lane`) when its program is named by a path from the working folder or inside the
  lane, or found through a `PATH` with a relative or empty entry; when its program runs what the working folder's own files
  name (package managers and runners: `npm`, `npx`, `pnpm`, `yarn`, `bun`, `deno`, `tsx`, `uv`, `uvx`, `poetry`, `pipenv`,
  `make`, `just`, `cargo`, `go`, `mvn`, `gradle`, `dotnet`, `bundle`, `composer`, `git`; shells and wrappers such as `sh`,
  `env` and `xargs`; `python` with `-m` or `-c`; `node` loading a module or inline code; `docker` or `podman` with `compose` or
  `build`); when an argument, a part of one (an option's value after `=`, a bind mount's `.:/app`), or a variable's value names
  something of the lane's (an absolute path inside it, a path from `.` or `..`, or a relative name whose first part is in
  the lane, such as `mcp/server.js` or `server.py`); when `NODE_OPTIONS` loads a module; or when a variable ending in `PATH` or
  `LIB` has an empty entry; or (item 118) when it is an agent's own CLI (`claude mcp serve`, `codex mcp-server`, any agent),
  which started in the lane's folder reads that folder's own agent settings as its project's (hooks in
  `.claude/settings.json`, `.codex/config.toml`, `opencode.json`), files the lane's agent can change. An agent's CLI is read
  as `fg.rs` reads which agent runs in a terminal (`acp_mcp::an_agents_cli`, `fg::agent_for_process`): the agents the app
  starts and the few a person runs themselves (`hermes`, `amp`, `goose`, `aider`), by name (with a Windows ending in any
  case; `grok`, `pi` and `dsh`, which other programs share, count by name here too), by its real path, found on `PATH` when
  it is named alone (a link of another name leads to the agent it is), by an npm package's folder in that path, and for
  `node` and the other interpreters by the script they run. The chat says "Not started in this lane: <names>. It runs files
  from the lane's own folder, which the lane's agent can change. It starts in a chat in your project folder."
  (`mcp_lane_files`, names only), for an agent's CLI too, whose settings are such files. What a person loses: in a lane, a
  project server started through `npx` or `uvx` (the usual way to name one) no longer starts, nor one whose argument
  happens to name a file the lane has, nor an agent's own MCP server; in their own folder every approved server starts as
  before. Not ruled out: a program named alone that reads its working folder by itself, with no word naming it (a server
  that loads `./config.js` on its own), and an agent this reader does not know, or one copied (not linked) under another
  name outside an npm package, or a server built on an agent's SDK that starts the agent's CLI itself. This one source because `.mcp.json` lives in the folder the agent already works in, so its
  literal values are ones the agent can read anyway, and its `${VAR}` and `${VAR:-default}` are filled in from the environment
  the agent already runs with (a server with a variable that is not set is left out). The servers the person added to Claude
  Code or Codex themselves are not handed on: their secrets were given to those agents. Shapes from the protocol's Session
  Setup page: stdio `{name, command, args, env: [{name, value}]}` always, HTTP and SSE (`{type, name, url, headers}`) only to
  an agent whose `mcpCapabilities` takes them. The values go only into that line to the agent, never an event or a log.
- **Settings › MCP and Skills** (`src/settings/mcp/McpSkillsPage.tsx`, `src-tauri/src/agent_config.rs`). For Claude Code
  and Codex: each MCP server and skill by name, where it comes from (yours in every project, yours in this project, the
  project's file, a plugin), and whether it is on, turned off or waits for a yes; with a project folder chosen, that project's
  too. Read from the agents' own files, never by running them (`claude mcp list` starts every server to check it and prints
  each command): Claude Code's `.claude.json`, the project's `.mcp.json`, the plugins its user settings turn on (their
  `.mcp.json`, `plugin.json` and `skills/`, found through its `installed_plugins.json`), its `skills/` and the project's;
  Codex's `config.toml` (`enabled = false` is off) and the project's `.codex/config.toml` (waits until Codex trusts the
  project), its `skills/` (Codex lists it as a skill root in `codex debug prompt-input`), `~/.agents/skills` and the project's.
  Names only reach the page: never a command, argument, environment value, header or address. Whether a server connected is
  what Claude Code's last chat said in its first line (`mcp_servers`, kept as a name and one of a few status words, in memory
  until the app closes); Codex's is not known. Plugin skills are one row per plugin. The page changes nothing and names the
  commands that do (`claude mcp add`, `codex mcp remove`, the skills folders), says where else the settings reach, and in a
  browser says there is nothing to read.

### What a project's own files cannot do

Item 89 (security review, 26 Nov 2026). A chat starts its agent headless, and `claude -p` skips Claude Code's "Do you trust this
folder?" question (`claude --help`: "The workspace trust dialog is skipped when Claude is run in non-interactive mode"). So
before this item a repository's own files acted in every chat the app started: a committed `.claude/settings.json` hook ran on
the Mac, an untracked `.claude/settings.local.json` (one a lane copied in, or one a build step wrote) could allow all of Bash so
that Kit's dial never saw those asks, a `defaultMode` could start the chat in Accept edits, and `.mcp.json` servers connected
without asking (Claude Code's permissions page, "What runs before you trust a folder", `claude -p` column). Now no file inside a
project folder or a lane's folder, committed or copied in, can run a hook, allow a tool, set a permission mode, or name a key
helper or a status line program in a chat the app starts, where the agent has a switch for it:

- **Claude Code** (every chat, a lane's or not, and Buddy's): `--setting-sources user` (`sessions::CLAUDE_CHAT_ARGS`). The
  permissions page names this flag for `claude -p` in a repository you did not write ("reads neither the project's settings
  files nor its `.mcp.json`"), and the Agent SDK page says what each source loads: `project` is `.claude/settings.json` and
  its hooks, CLAUDE.md and `.claude/rules` in the folder and every folder above it, and the folder's skills, commands and
  subagents; `local` is `.claude/settings.local.json` and `CLAUDE.local.md`. Every chat also starts with
  `--permission-mode` named on its command line (`agent_chat::start_mode`): the mode the person picked (a Restart, a restart of
  the app), else Ask (`default`), so a `defaultMode` in any file, the person's own included, never chooses it. The page passes
  the mode with `chat_start` and no longer sets it after the start; a mode the agent does not offer refuses the start.
- **Codex**: its thread starts (`thread/start`, `thread/resume`) with the approval policy and sandbox of the chat's mode, Ask
  (`untrusted`, `workspace-write`) unless the person picked another, and every turn carries them, as before.
- **OpenCode**: `OPENCODE_DISABLE_PROJECT_CONFIG=1` (OpenCode's CLI documentation: "Disable project configuration and project
  instruction files"). Checked on this Mac with OpenCode 2.3.0: `opencode debug config --standalone` in a folder with an
  `opencode.json` and a `.opencode` folder lists both as sources without it and neither with it, while the person's own
  configuration and an inline `OPENCODE_CONFIG_CONTENT` stay. A person's variable of that name is refused on Settings ›
  Providers, as the app's own, and the app's value goes last.

  **How OpenCode's own rules are read** (item 89, both forms since item 114). Before a chat starts, OpenCode lists its agents
  and their resolved permission rules, the app builds ask rules from them (what the person allows for the shell and for edits
  asks, what they deny stays denied) and sets them in `OPENCODE_CONFIG_CONTENT`, lists again, and starts the chat only when
  OpenCode took exactly them and nothing else changed (`acp_chat::probe_rules`). OpenCode 2.3.0 has no `opencode agent list`:
  it prints its help and ends with code 1, so every OpenCode chat was refused on this Mac. It lists the same fact as JSON with
  `opencode debug agents --standalone` (each agent's `id`, `mode` and `permissions` as `action`, `resource`, `effect`), names the
  shell tool `shell` rather than `bash` (its config still takes `bash`), matches case as written on every platform, and
  decides by the last rule that matches, else ask (read in its bundle, and recorded on this Mac for five configs in
  `tests/fixtures/acp/opencode2-rules.json`). `--standalone` matters: without it the listing comes from OpenCode's background
  service, started earlier with other variables, while `opencode acp` always starts a server of its own that inherits the
  chat's. The app tries the 2.x listing first and then 1.x's `agent list`; a listing that fails or cannot be read moves on to
  the other, one whose rules were read but not kept refuses the chat at once, and neither readable refuses it as before ("could
  not confirm it would keep your own OpenCode permission rules"). Not exercised: an OpenCode 2.3.0 chat itself (no agent was
  run), so how 2.3.0's ACP side answers the chat's own messages is still only what item 89 recorded from 1.19.5; and
  2.3.0's Code Mode `execute` and its own schedules, which are other actions than the shell and edits.

  Since item 114 the inline value (after the ask rules) also says
  `"formatter": false` and `"lsp": false`: OpenCode runs formatters after its write, edit and patch tools and language servers
  for the files it touches, and both find and run the project's own tools and configs (a project-local Prettier, an ESLint
  config), so the person's own config switching them on would still run the project's code with no card. Both keys take
  `false` as "disabled" in OpenCode's own schema (1.x: "Omit or set to false to disable"; 2.3.0's config reader takes a boolean
  for each, and `opencode debug config --standalone` on this Mac lists the inline value with both after the person's own
  config, where a later `false` wins). Only a managed or organisation config, which OpenCode reads after it, could switch them
  on again.

  With a project's instructions file (item 93) the value OpenCode gets is one JSON object in three parts, in this order: the
  ask rules (`agent`), then `"formatter": false, "lsp": false`, then the one `instructions` entry. The first two are what the
  rules are built as and what `kept` rebuilds from a listing and compares byte for byte; the entry is added after them
  (`acp_chat::with_instructions`, which leaves that text as it was), before the second listing, in whichever form was read
  (`acp_chat::probe_rules`). So the value listed again is the very value the chat starts with, and a path the value cannot
  carry refuses the start.

**What a developer loses inside an app chat.** Claude Code: the project's `.claude/settings.json` and
`.claude/settings.local.json` no longer apply, so their hooks, their allow, ask and deny rules (a team's deny rules
included), `env`, `defaultMode`, plugins (`enabledPlugins`) and model; the project's `.mcp.json` servers do not connect, even
approved ones; Claude Code no longer reads the project's instruction files itself, so the app reads them and hands them over as
text, and what that still leaves out is in [A project's own instructions, as text](#a-projects-own-instructions-as-text) (item
93); the project's skills, commands and subagents are not offered; a "don't ask again" Claude Code writes to the local file is
not read back. Buddy's chat, in its own empty folder, no longer reads a CLAUDE.md in the folders above it (`~/CLAUDE.md`).
OpenCode: the project's `opencode.json` and `.opencode` folder no longer apply; its instruction files come as text from the app
too (item 93); and the formatters and language servers the person's own config switches on are off (item 114), so files the
agent writes are not formatted for it and it gets no diagnostics from a language server. What stays,
as a terminal would have it: the person's own settings, CLAUDE.md, rules, skills, commands, subagents and the plugins their
own settings turn on, the MCP servers in `~/.claude.json` and their claude.ai connectors (read whatever the sources, Agent SDK
page), managed settings, and auto memory. Kit's dial and the cards are unchanged. A developer who wants a project's own setup
can open the folder in a terminal session, where Claude Code asks its own trust question, or move what they need into their
user settings. Not confirmed by running Claude Code: whether a folder's local-scope MCP servers in `~/.claude.json` still
connect (the SDK page says the file is always read), and whether output styles or Claude Code workflows in the project are
held by the source list (neither can run a program or allow a tool on its own).

**The other agents, by agent.** Each one's project files read from its own help and documentation (no agent was run):

| Agent | Project files that can allow a tool or run a program | Switch | Here |
| --- | --- | --- | --- |
| Codex | `.codex/config.toml` (approval, sandbox, MCP servers, hooks), loaded only for a project the person trusted in Codex | none that leaves out the project layer; `-c` sets single keys | the thread's mode is named (above). Open: a project the person trusted in Codex still starts its MCP servers and hooks |
| OpenCode | `opencode.json(c)`, `.opencode/` (permissions, MCP servers, plugins, formatters, agents) | `OPENCODE_DISABLE_PROJECT_CONFIG` | on (above) |
| Gemini CLI | `.gemini/settings.json` (`tools.allowed`, `general.defaultApprovalMode`, MCP servers, hooks), `.gemini/.env`, `.env` | folder trust (`security.folderTrust.enabled`), which the documentation calls both off and on by default; nothing found that leaves out project settings and keeps the person's | open: whether trust holds under `--acp` is not documented |
| Qwen Code | `.qwen/settings.json` (`permissions.allow`, `tools.approvalMode`, MCP servers, hooks) | folder trust, off by default | open (not installed here) |
| Kimi Code | none found: its hooks are user-level only ("there is no project-level hook file") | none needed for hooks | open for MCP and permission files (not installed here) |
| Copilot CLI | `.github/copilot/settings.json`, part of `.claude/settings.json`, `.github/hooks/*.json` (after workspace admission), `.mcp.json` and `.github/mcp.json` | none found | open (not installed here) |
| Cline | `.cline/hooks/`, `.clinerules` | none found (`--hooks-dir` only adds) | open |
| Cursor | `.cursor/cli.json` (`permissions.allow`), `.cursor/hooks.json` (needs workspace trust), `.cursor/mcp.json` (needs approval) | none found; `--trust` is the opposite and is refused | open |
| Antigravity | not read: its hooks, MCP and project pages were not reached | `--include-default-customizations=false` is untested | open |
| pi | `.pi/extensions` (code), `.pi/settings.json` (`packages`, `extensions`), loaded after project trust (`defaultProjectTrust`, agent-folder settings only) | none for the rpc mode found | open (not installed here) |
| oh-my-pi | `.omp/` hooks and extensions, `.omp/mcp.json` | `--no-extensions` also drops the person's own; `--approval-mode` unconfirmed against project settings | open |
| OmO, DeepSeek Harness, a person's own agent | not read (not installed here, or the person's) | | open |

Grok runs only as its own terminal, where its own prompts apply. `docs/decisions.md` has the call (item 89).

### A project's own instructions, as text

Item 93 (26 Nov 2026). The switches above also kept out a project's instruction files, which are only words: they cannot run a
program, allow a tool or set a mode. So the agent in a lane no longer knew the project's conventions. Now the shell reads those
files itself, as plain text, when a chat of Claude Code or OpenCode starts in a lane or a project folder, and hands the text to
the agent (`src-tauri/src/project_notes.rs`). Every action still asks through Kit's dial as before. It is on for every chat,
with no switch.

**Which files.** From the folder the chat works in (a lane's own folder, so the lane's version of a file is the one read) and
each folder above it up to the project's top: the nearest folder holding `.git` (a repository, or a lane's worktree), else the
chat's folder alone. Never the person's home folder or anything above it, even when the home folder is kept in git.

- Claude Code (its memory page, code.claude.com/docs/en/memory): at each folder from the top down, `CLAUDE.md`,
  `.claude/CLAUDE.md`, every `.claude/rules/**/*.md` without a `paths` field (its frontmatter removed, as Claude Code does),
  then `CLAUDE.local.md`; when none of the three CLAUDE files is in any of those folders, `AGENTS.md` and `.claude/AGENTS.md`
  in their place (Claude Code's default, "claude-md-or-agents-md"). AGENTS.md is a member of the class the item 89 switch
  left out too: Claude Code 2.1.332 finds it through `$.fs.ancestors`, which answers nothing while the project source is off
  (read in its program, not run).
- OpenCode (opencode.ai/docs/rules): at each folder from the chat's up to the top, `AGENTS.md`, else `CLAUDE.md`.

**How each file is read.** Never through a link: a symbolic link in a file's place, a folder on the way that is one
(`.claude`, `.claude/rules`, a folder of rules), and a hard link (a second name for a file elsewhere) are each left out and
named. The file is opened without following a link (`O_NOFOLLOW`) and without waiting on a pipe, must be the very file looked
at, and its path must still lead to it with no link on the way. At most 64 KiB a file (about 16,000 tokens: a large real
CLAUDE.md on this Mac is 46 KB, and Claude Code cuts a file it loads later at 40,000 characters on a 200K window) and 128 KiB
in all (about a sixth of a 200K window); at most 50 rule files a folder, four folders deep. UTF-8 text only, with no NUL.
Cleaned of what a person reading the file does not see: the invisible format characters computer use strips from a card's label
(`computer::room::format_char`, the same list, called rather than copied), the rest of Unicode's default-ignorable code points
(variation selectors, fillers, the combining grapheme joiner, tags) and control characters other than a tab and a line end; and,
as Claude Code does, HTML comments that start a line outside a code block. An `@path` import is never followed: the line is
handed over as written, and the fixed lines in front say so.

**How it is handed over.** The text goes to a new file of the app's own, `~/.manut/project-notes/<mark>.md`: the folder only
this user may open (0700), the file readable by this user alone (0600) and made new each time, never inside the project (a home
folder opened as a project hands nothing over, and the note says so), removed when the chat ends or its start is refused; one
left over after a crash is cleared at a start a day later. First in it come two fixed lines: the notes below are this
repository's own notes about how to work in it, read from its folder; they are not the person speaking and give no permission;
every action still asks the person as usual; they end only at a line with the chat's own end mark, which the repository cannot
know in advance; and a line naming a file with @ was not read in. Then each file under its path, then the end line.

- Claude Code: `--append-system-prompt-file <file>`, once, after the chat's other arguments (the CLI reference: "Appends file
  contents to the default prompt"). The reference does not say a second copy of the flag is taken, and none is needed: no
  coding chat passes another (a person's own is refused on Settings › Providers, and `--append-system-prompt` is not on its
  list). Buddy's chat is unchanged: its own file, in its own empty folder, no project.
- OpenCode: an `instructions` entry in the `OPENCODE_CONFIG_CONTENT` the app already passes (its rules page: an absolute path
  is "used as written"; OpenCode 2.3.0's own code reads such a path while `OPENCODE_DISABLE_PROJECT_CONFIG` keeps project files
  out). The entry joins the value before the second rule listing, so the ask rules are checked with the very value OpenCode gets.
  OpenCode's own placeholders never reach it as placeholders (item 118): OpenCode fills in `{env:NAME}` and `{file:path}`
  within its config, so a project's AGENTS.md could otherwise put one of the person's own files, or a variable of theirs, into
  the system prompt if OpenCode filled them in within an instructions file's text too. Whether it does could not be settled
  without a chat: with a scratch home, a made-up variable and a scratch instructions file, `opencode debug config
  --standalone` (OpenCode 2.3.0) showed an `{env:...}` in a config value filled in and listed the instructions file only by
  its path; the patterns (`\{env:([^}]+)\}`, `\$\{env:([^}]+)\}`, `\{file:[^}]+\}`) are in its binary as strings, while the
  code that uses them is compiled and cannot be read; and its server's API (`/openapi.json`) holds instruction entries only
  for a session. So the text written for OpenCode, paths included, has a space after the brace of every `{env:` and `{file:`
  in any letter case (`project_notes::inert_for_opencode`): no pattern matches, and the words stay readable. Claude Code's
  text is handed over as written. The path in the entry still refuses either token, as before.

**What the chat says.** One quiet line, once: "Read this project's CLAUDE.md." with the files it read, and "Left out: …" with
each file left out and why (a link, over 64 KB, over 128 KB in all, not plain text, only for some files, could not be passed
on). A chat restarted on the same files adds no second line. With no instruction file, nothing is handed over and nothing is
said.

**What is still left out.** Folders above the project's top; a subfolder's CLAUDE.md, which Claude Code loads only when it
works in that folder (the agent can still read one); rules with a `paths` field, which Claude Code loads only for matching
files; anything an `@path` import names; an AGENTS.md beside a CLAUDE file (Claude Code's default reads one or the other).
Claude Code puts its own CLAUDE.md in a message after the system prompt; the app's text is appended to the system prompt
itself. A conversation continued after a restart keeps the system prompt it recorded on its first request until it is
compacted (`claude --help`, `--system-prompt-snapshot`), so it keeps the instructions it started with until then.

**Not changed.** Codex and every other agent were not switched off by item 89 and still read their own project files as they
always did; the app hands them nothing. Checked only with stand-ins: whether Claude Code reads the file again after a
compaction (the file stays until the chat ends either way), and OpenCode's start, because on this Mac OpenCode 2.3.0 has no
`opencode agent list` (it prints its help), so its ask-rule listing fails and an OpenCode chat does not start at all (item 89's
rule, unchanged by this item).

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

The preview of a lane runs with `previewEnv` (see [The preview of a lane](#the-preview-of-a-lane)), with a sample too for each secret
the lane folder's `.env.example` names. Nothing saves a secret: Add the shop ID says the vault comes later.

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

**A lane's preview** (see [The preview of a lane](#the-preview-of-a-lane)) is listed too, as a kind of its own (`Kind::Preview`,
from `Previews::roots`): one row, the preview's own program (`pnpm run dev`), with the ports of everything it started, tagged
Preview instead of Running and named by its lane. Its Stop goes through the preview's own stop, which ends its process group, so
its pane says Stopped.

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

## Workflows

Item 77b, from the owner's T3 Code Labs screenshot: "run multi-step workflows from files in the workflows folder ... Skipped
runs kept". A workflow is a list of messages to a coding agent, kept as a file and run in order, as a lane of its own, when
the person presses Run now or at its time. Settings › Workflows holds all of it; nothing else in the app changes until the person
turns it on.

**The file.** One JSON file for each workflow in `~/.manut/workflows/` (the file's name, letters, digits, `.`, `_` and `-` ending in
`.json`, is the workflow's id):

```json
{
  "name": "Nightly tests",
  "project": "/Users/nam/code/shop-site",
  "agent": "claude",
  "steps": ["Run the tests and list the ones that fail.", "Fix the failing tests, then run them again."],
  "schedule": { "kind": "daily", "at": "02:00" },
  "timeZone": "Asia/Bangkok"
}
```

`name` (1 to 80 characters), `project` (a full folder path, no `..`), `agent` (an agent's id as Settings › Providers lists it) and
`steps` (1 to 20, each 1 to 4,000 characters) are needed. `schedule` is a routine's trigger from `@manut/routine-rules`: `daily`,
`weekly` with `weekdays` (0 is Sunday) or `monthly` with `day` (1 to 28, or `"last"`), each with `at` (24-hour `HH:MM`); without
one the workflow runs only on Run now. `timeZone` is an IANA name; without one the time is this computer's. `version` may be left
out or be 1. Any other field is refused by name. JSON and not T3 Code's TypeScript workflows: a file of data runs no code of its
own, and the app's other files are JSON (decisions, 25 Nov 2026).

**Reading it.** The shell (`src-tauri/src/workflows.rs`, `workflows_read`) lists the folder's `.json` files in name order, at most
100, each with its text or why it did not read it: a name that is not plain, a link (never read through one, nor a folder that is
one), over 64 KB, not UTF-8. Dot-files, subfolders and other files are left alone. `workflows/file.ts` checks every field; the page
lists a file that is not a workflow with its first reason in words, and a second workflow of the same name as a duplicate of the
first. The app never writes, renames or removes a file there; Show folder (`workflows_folder`) only makes the folder. A file any of
whose text holds a character the card cannot show as an agent reads it is refused whole (item 91): controls other than a line
break or a tab, format characters (zero-width marks and joiners, text-direction overrides and isolates, the invisible tag
letters, a soft hyphen), private-use and unassigned code points and lone surrogates. So what the person reads is all the agent
is sent.

**Allowing it (item 91).** Anything that can write in `~/.manut/workflows` (the person, another program of theirs, an agent) can
write a workflow, so a file runs only once the person has read it. Each card shows, under "Steps and project", every step's text
in full and in order (kept as written, line breaks included, never cut), the project's whole folder and the agent, with "Allow
this workflow to run" under them. The panel is open by itself while the workflow is not allowed, and stays in the page, hidden,
while closed. The press allows the text the card drew: what is kept is the SHA-256 of the file's exact text (`file.ts` `digest`)
and the project's real path from the shell's check, in `localStorage` `manut.workflows.allowed` beside the other Settings
choices, never in the workflows folder. When the folder holds anything else for that file by the time the press lands, nothing is
kept. "Stop allowing" takes it back. A record that cannot be read, or an entry that is not exactly an allowance, allows nothing.
A new file, a renamed one, one that took another workflow's name (`0-x.json` sorting first makes the allowed file a duplicate,
which runs neither) and one whose text changed in any way, a space included, are not allowed: Run now cannot be pressed, the card
says "Not allowed to run yet ..." or "This workflow's file changed. Look at it again.", and the palette does not offer it. The
Workflows switch is still the master switch.

**Its project (item 91).** The shell checks the project when the person allows the workflow and again before every run
(`workflows_project`, `workflows.rs` `project`). It must be the top folder of a git repository (`.git` right in it, and `git
rev-parse --show-toplevel`, run as the app's automatic work runs git, naming that same folder), written as its real path (a link
on the way, or letters the disk writes differently, is refused), and not the home folder, a disk's top (no folder above it, or on
another disk than the one above), a folder that holds the home folder or the app's own folder (wherever `~/.manut` really is),
or anything inside the app's own folder or a lane's folder. Each refusal is a short code the card says in words (`missing`,
`link`, `too_broad`, `app_folder`, `not_repo`, `no_git`); no answer, or one the page does not know, is `unchecked` and allows
nothing. A project whose real path is not the one allowed does not run (`moved`).

**A run.** Run now (or the clock) reads the folder again, and only while that file is exactly the text allowed and its project
passes the shell's check again does the run start a lane the way a person's own lane starts (`startWorkflowLane` in
`sessions/sessions.ts`): a New session chat on the workflow's agent in the project's checked real path, started by `start` with
step 1 as its first message, so it has a branch and a folder of its own and is listed in the Lanes band. The steps it sends are
the ones read from that same text. A workflow's lane that could not get a branch and folder of its own (no lane maker, git
refusing, an agent that is not a chat) starts no agent at all: `start` closes the session and `startWorkflowLane` answers
`no_lane`. Each run that did not start, by the clock or by a press, is kept as skipped with why, and the card says it. It is made beside the
person's drafts and never in place of one, is not opened in front of them, changes neither how they last opened the agent nor
their last folder, and is named after the workflow. When a step's turn ends `done`, the next step goes through `send`, as the
person's next message would, until the last.

**A run nobody started by a press (item 114).** A run by the clock makes its lane with nobody there, so the lane is the app's
own doing, as the automatic pull is: the page asks the shell for it with `unattended` (`LaneStart`), and `lane::make_with` then
runs git as automatic work runs it (`Git::automatic`: no `ext::` remote, never into a submodule) and first reads the repository's
own config and every submodule's (`Git::config_risk`, the same read as "Git the app runs by itself" above). While that names a
program git would run or another address to fetch from, nothing is made, checked out, counted or fetched: `git worktree add`
would run a smudge filter as it checks the files out, the count of the developer's files that did not come along a clean
filter, and Start from the remote an `ext::` address or a proxy. Since item 118 the folder is then added with nothing checked
out and the config read again from inside it before any file is written (see "Includes, and the folder git runs in"). The
shell answers `config:<setting>`, no agent starts, and the
run is kept as skipped (`config`) with the setting as its detail; the card says "Did not run: this project's own git settings
name a program for git to run, or another address to fetch from. The app does not run those by itself while nobody is there;
press Run now if you trust them." Only a press counts as someone there (`by === "person"`), so any way a run starts later (a
webhook) is read as nobody there. Run now, and a lane the person starts from the chat box, stay as item 86 decided: the person
is there and chose to act on that project, so git runs with their settings and the repository's, as in a terminal.

- **An ask waits.** The run never answers one. An ask in any step is on its card and in Needs you as always, and the run waits
  there, since the turn has not ended; the page says "Waiting for you at step 2 of 3".
- **It ends** when a turn fails (Failed, with the agent's words, any key hidden by the app's masker and cut at 300 characters), the
  person stops a turn (Stopped), the agent ends, the lane is closed, or the person pressed Stop after this step (it stops when that
  step's turn ends). A turn the agent began on its own while the step waited behind it is not the step's.
- **One run of a workflow at a time.** Run now is refused while one goes; a time that comes then is kept as skipped, "Its last run
  was still going". Two workflows may run at once, as two lanes do.
- **The agent** must be one a person could start a lane with now: installed, on in Settings › Providers, and a chat here.
  Otherwise the run is Failed with that reason and nothing starts.
- **The most careful setting.** Nobody may be watching, so the lane reads its asks at Kit's lowest level, Asks every time, with no
  kept rule, whatever the project's dial says (`careful` on `code/kitAsks.ts`' context), and starts in the agent's Ask mode
  (Claude Code `default`, Codex `ask`), named when the agent starts, as every chat's mode is since item 89 (see
  [What a project's own files cannot do](#what-a-projects-own-files-cannot-do)). Reading files and running the tests still go alone, and a step outside the project is still
  stopped. The mark (`SessionRec.workflow`) is saved with the session, so a lane that comes back after a restart stays careful. The
  lane's box shows that level and says why instead of the dial; the chat says it as the lane starts; the page says it under the
  switch.

**When it runs by itself.** Only while the app is open, the Mac is awake and Workflows is on: no service is installed and nothing
wakes the Mac (Settings › General's "Keep the computer awake while agents work" applies to a workflow's lane as to any lane). The
app looks at the clock every 30 seconds (`workflows/schedule.ts`, reading only the folder and the time, never the network). A time
read at most 2 minutes late runs. One further back is not made up: it is kept as skipped, "The app was not open" when it fell
before this run of the app began, "The Mac was asleep, or the app could not check the clock" after. A time before the app first saw
the file is not counted, and turning Workflows on starts the clock from then, so nothing missed while it was off is listed. The time
is in the workflow's zone, else this computer's, named with `lib/zone.ts`' words when it is not this computer's ("Every day at 02:00
(Bangkok time) · Next: Today 02:00").

**Off by default.** While off, nothing in the folder runs, Run now is not offered and nothing is scheduled. A run going when it is
turned off finishes its current turn and stops ("Workflows was turned off"); unlike T3 Code's, it is not held to go on later.

**The history.** Each run keeps when it started (and when it was due), who started it, which step it reached and how it ended, on
this computer (`localStorage` `manut.workflows.runs`). Each workflow keeps its newest 20 runs that did something and its newest
skipped runs up to Settings' "Skipped runs kept" (0 to 500, default 50; 0 keeps none), bounded again as soon as it changes. A run
the app closed in the middle of says "The app closed while it ran" when the app opens again. The page shows each workflow's newest
10.

**The command palette** lists "Run workflow: <name>" for each workflow whose Run now can be pressed now (on, allowed as the file is
now, and not running). It opens Settings › Workflows
and presses that Run now, so it adds no power of its own (`palette/registry.ts`, held to the button by `registry.test.ts`), and
"Settings › Workflows" is in its Go to list as every Settings page is.

**Files.** `src-tauri/src/workflows.rs` (the folder and the project's check, with their tests); `src/workflows/file.ts` (the file
and its checks), `allow.ts` (what the person allowed), `schedule.ts` (the clock), `history.ts` (the runs and their bounds),
`settings.ts` (the switch and Skipped runs kept), `runner.ts` (runs, the clock's ticks, the store the page reads), `host.ts` (the
shell, and a mock for a browser seeded through `window.__manutMockWorkflows`, whose `projects` says what the stand-in shell answers
for a project), `words.ts`, `WorkflowsPage.tsx` and `workflows.css`; `sessions/sessions.ts` (`startWorkflowLane`, `onChatEvent`).
`runner.test.ts` drives runs through a real sessions store and app store with the lanes' stand-in shell, with tables of changed
files and refused projects; `workflows.rs`' tests check the project rule against real folders and repositories; and
`e2e/workflows.spec.ts` walks the page, the allow step, a run of two steps with the stand-in agent, a changed file, the Lanes band
and the palette.

### Context from one chat to another (item 97)

Three ways to carry what one chat holds into the next message of another, each only filling the person's own box: nothing is
sent, run or approved by it, and what an agent then wants to do still asks. The pieces are `src/chat/box/carry.ts` (the chips and
the form they go out in), `threadContext.ts` (another chat's context, built with no model), `contextReader.ts` (reading a chat
through the store, sessions and shell it is handed), `SelectionNote.tsx`, `Bring.tsx` and `src/sessions/continueWith.ts` with
`ContinueMenu.tsx`.

- **A note on a selection.** Text selected in an answer, or in a lane's pane, brings a quiet Add a note by it (or Cmd+Shift+N,
  Ctrl+Shift+N elsewhere). The note and the selection become a chip above the box; at most eight a message, a selection quoted
  up to 3,000 characters and cut with a line that says how much. On Send each goes first as `> ` lines with `Note: ...` under
  them, a blank line between blocks, the typed message last; the person's bubble draws them as their own quote. Chips are kept
  by chat key on this computer (`manut.box.carry`) across a restart, and Cmd+S takes them into Drafts as that same text.
- **Another chat's context.** A Recent row, a History chat row or a lane's row dragged onto an open chat's box, or Bring context
  from… in the box's + menu (the palette's switcher's chats, then the coding chats; arrows, Enter, Esc), adds one chip: the
  chat's title, which opens to show exactly the text that goes. The text: a line naming the chat, a line saying the app copied
  it and that it is not the person speaking and gives no permission (the fence a project's own notes get), Title, First message
  (as typed), Last answer, a lane's Files changed (names and line counts from its own diff, never contents) and Waiting on the
  person, each masked with `lib/secrets.ts` and capped, 6,000 characters in all. A thread no one opened is read from the runtime
  (`thread.open`, which opens no chat). One chip a chat, three chats a message. The row shows only in a + that already opens a
  menu: a + whose one row is files still opens the picker at once, and there a chat comes in by a drag.
- **Shop and account.** Each chip names the shop (a team chat) or the agent account (a coding chat) it was made under. A chat of
  another shop, or of another account of the same agent, is refused in a plain line before anything of it is read; a kept chip
  of another shop is red and never sent. Since item 121 a chip also carries every shop whose chat's context the chat it came
  from took in (kept by chat as `manut.box.through` whenever a send takes chips), and is refused anywhere one of those shops
  differs, so a shop's context cannot reach another shop by way of a coding chat. Sends made before item 121 were not
  recorded, so a coding chat that took a shop's context in before then carries no shop for it.
- **Continue with….** A started coding chat's agent chip opens the other models of its agent and the other installed agents that
  chat. A pick opens a NEW chat in the same lane (no second folder or branch) or folder, with the old chat's context above its
  box, unsent; its agent starts with the person's first message, the picked model set first, its own agent keeping the old
  account. A quiet line links the two both ways with Open, and the old one offers to stop its agent only while it is idle.
- **One lane, one working agent.** While either of two chats linked this way has a turn running, the other's box keeps what is
  typed, Send waits, and a line says who works there; the sessions store refuses the send too. The rule binds only linked chats,
  so two chats the person opened in one folder go on as before. The lane's folder goes only when the last chat in it is closed.
- **A summary by a model** is not built: item 96's runs would plug in at `buildContext`, its text in place of First message and
  Last answer, still masked, capped and shown before it goes.

`carry.test.ts`, `threadContext.test.ts` and `sessions/continueWith.test.ts` hold the rules; `e2e/thread-context.spec.ts` walks
all three on the mock host, by mouse and by keyboard, with pictures in light and dark at 1280 and 900 (`MANUT_SHOTS`).

## Left for later (no owner needed)

- From item 91 (Workflows): the allowance lives in the app's web storage on this computer, which a program of the person's can
  reach as it can any of their files; the dial must ask before any agent writes under `~/.manut` or the app's own storage (named
  in item 91's report). Between the run's check of the project and git making the lane, a folder swapped for a link would be read
  by git as it is then: a link to a folder that is no repository makes no lane, so nothing runs, but a link to another repository
  would make the lane from that one. On Windows a disk's top is known only as a drive's root (no mount check), untried.
- From item 77b (Workflows): a New workflow form that writes a file (today a person writes the file, or asks an agent to); a run
  that goes on after the app restarts (today it ends as "The app closed while it ran"); a run on another project's lane settings
  (the dial is always Asks every time); a workflow's own steps that branch, wait or ask the person (T3 Code's `ask` and `step`):
  today a step is a message and the agent's own asks are the only questions. Not tried with a real agent: no message was sent to
  one for this item.
- From item 72 (MCP servers and skills): Claude Code's own MCP servers (user and local scope, in its `.claude.json`) in an
  added Claude Code account, which would need a safe way to write a file Claude Code rewrites while it runs; added accounts of
  Grok, pi and oh-my-pi, and every added account on Windows; the lists of the agents other than Claude Code and Codex on
  Settings › MCP and Skills (each reads its own files in its own format, to be checked against its documentation); Codex's
  plugins' servers and skills on that page, and whether Codex connected a server; project files of the other agents
  (Gemini's `.gemini/`, OpenCode's) in a lane; a skill that is a link, or a nested repository, in the developer's folder,
  which a lane leaves behind.
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
- Ask Kit to fix it on a lane, and the effort word. (Open pull request is item 75's Put up for review.)
- A sign-in the app cannot read (pi, oh-my-pi, OpenCode, OmO, DeepSeek Harness, the ACP agents): no mark before the first
  message, only the chat's own words after it. A status command for each would need the shell's fixed list in
  `src-tauri/src/accounts.rs` to grow.
- The pane beside a lane: a way to hide it (it is always there for a lane); the totals of a file's several changes, not only the
  newest one; Diff, Preview and Tests of a lane from the Code page's row, where only the session view has them; a Diff of a
  session in the developer's own folder (it reads from the chat's events, as before).
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
- The preview of a lane, past its second slice: Windows (an environment list of its own and the package manager's `.cmd` shim,
  and for the page in the pane, a frame that does not hold Tauri's scripts, which WebView2 puts in every frame); the page in the
  pane at `[::1]` (no CSP source names it); the shell's hook telling the frame from the window, so the window could load only the
  app's own pages and the frame only loopback ones (on macOS the outpost's delegate in front of wry's shows how); a
  preview from the Code page's lane row, where only the session view has one; the owner's own secrets once a vault exists
  (`previewSecrets` already takes them as `added`); an address read from the ports a preview listens on when it prints none; a
  preview kept through a reload or a restart of the app (every one stops); and a lane that runs in its own terminal, which has no
  pane.
- Where an agent's shell is. Since item 116 every Claude Code the app starts (a chat, Buddy, a terminal, a title run)
  runs with `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` (`fixed_env` in `src-tauri/src/providers.rs`, set after the
  person's own variables), so its shell starts every command in the session's folder and a `cd` no longer carries to
  the next command. The dial does not rely on that: see "The folder a session's commands run in".
- Asks that still name no path, so they ask the person: a search that names no folder, or a Glob whose pattern
  reaches past its folder; oh-my-pi's own edit, which names its file inside its patch; and an ACP agent's search or
  move.
- Kit asking for a secret, kept in this Mac's keychain without Kit seeing it: a keychain item per project, written from
  a password field and handed only to the commands that need it. That is Rust, and real secrets need the owner.

## Open in an editor (item 107)

A session row's menu, a lane's row menu and the command palette offer "Open in <Editor>", the third action of rule 30's folder
actions (`src-tauri/src/folder_open.rs`). It follows the same rules: the folder is an absolute path to a folder that exists and
is never put into a shell string, and nothing is run in it.

- **Which editors.** A fixed list the shell knows, in this order: Visual Studio Code, Cursor, Windsurf, Zed, Xcode (macOS only).
  Each is found on this computer by its app bundle (`/Applications`, `~/Applications`) or by its command (`code`, `cursor`,
  `windsurf`, `zed`) on the person's PATH, through `accounts::search_dirs` and `resolve`, never through a shell. On a Mac the
  bundle opens with `open -a <App> <folder>`, one argument each; a command found without a bundle, and every other system, runs
  the editor's own command with the folder as its one argument. JetBrains' launchers are not on the list: how each takes a folder
  was not confirmed from its documentation or from a `--help` on a computer that has one.
- **What crosses.** `editors_installed` lists (id, label) of the editors found; `session_open_in_editor` takes the folder and an
  id from the list. An id that is not on the list, or an editor not installed, is refused. A path or a command from the page is
  never an editor.
- **The choice.** Settings › Under the hood › Developer › Editor: Automatic (the first found, in the order above) or one found.
  Saved on this computer (`manut.editor`); a saved editor that is no longer found falls back to the first found, and the row
  says so. No free-text command: a typed command is a way to run anything, which needs the design of an ask (decisions).
- **Which folder.** A session opens the folder it works in (`workDir`): a lane's own worktree folder when it has one, never the
  developer's. The palette's "Open the project in <Editor>" opens the open project's folder on the Code page, which is the
  developer's own. When no editor is installed the action is not offered; a failure is said in the app's own words under the
  chat, under the lane, or at the top of the Code page.
