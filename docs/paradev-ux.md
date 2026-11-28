# Paradev's interaction and UX, and the code mode (28 Nov 2026)

The owner, 28 Nov 2026: "I really love the interaction and how UX from Paradev, make sure that we align with its best
practices" (`docs/decisions/2026-11-28-paradev-ux.md` has the ask and how the lead reads it). This is item 167's study: how
Paradev feels to use, area by area, beside Manut AI's code mode (Kit's chats and lanes, the pane beside a lane, the
terminals, the Code page, the palette and Settings for developers), each with a verdict. Item 138's study,
`docs/paradev-parity.md`, listed Paradev's features and what Manut AI has of them; nothing here repeats it. This one is about
how things move, show and answer: where a lane is, how a developer gets to another, what says that a lane needs them, what
the keys do, and what an empty or broken screen offers.

Two things stay as they are. Manut AI's look: the brand's faces, colours, type scale and motion rules
(`docs/design-audit.md`, `docs/motion.md`); a pattern is taken in that look, never in Paradev's. And its one promise:
anything public, costly or irreversible asks first, through approval-core, and settles once. No pattern below may skip an
ask, blur what it asks, or start an agent in a mode that does not ask. Buddy's side for shop owners keeps its own design.

## What was read

Paradev (`paradevai/paradev`, MIT, Copyright (c) 2025-2026 Superset Inc.) at `main`
`b0b0cdc6bd7eadf205a3fe8c45801affefbd89c5` (27 Nov 2026), cloned read-only into a temporary folder, never installed, built or
run; item 138 read the earlier `2db3bbaf`. Read: its desktop renderer (the keys, the command palette, the workspaces
sidebar, the workspace view with its tabs, panes and right sidebar, the chat session, the diff, the terminal pane, settings,
onboarding, the empty and error states), its motion stylesheet, its agent states, three pages of its docs
(`apps/docs/content/docs/agent-status.mdx`, `apps/docs/content/docs/keyboard-shortcuts.mdx`,
`apps/docs/content/docs/diff-viewer.mdx`), and its pictures, each opened and looked at. Its `readme/` folder holds only the
README's translations: the README's own pictures are in `apps/marketing/public/images/readme/`, the docs' in
`apps/docs/public/images/`.

Manut AI's code mode was read in its code and seen in pictures taken with this repository's own Playwright setup (below).

Paths. In Paradev's repository `R/` is `apps/desktop/src/renderer/`, `W/` is
`R/routes/_authenticated/_dashboard/workspace/$workspaceId/` and `S/` is
`R/routes/_authenticated/_dashboard/components/DashboardSidebar/`; any other Paradev path is from its root. In this
repository `src/` is `apps/desktop/src/`. A board is a file of the design canvas,
`~/Developer/manut-ai-artifacts/app-screens/project/<Board>.dc.html`, with its Dark twin where one exists.

Words: **adopt** (the pattern as Paradev has it, drawn in Manut AI's look), **adapt** (its idea, changed where it would
replace the look, skip or blur an ask, or start an agent that does not ask), **keep ours** (Manut AI's way stays, with why).

## The principles Paradev's interface keeps

1. **Keyboard first, and each key is taught where its action is.** One registry holds 90 actions with a key for each
   platform, grouped Navigation, Workspace, Layout, Terminal, Chat, Window and Help (`R/hotkeys/registry.ts`); a printable
   chord follows the key printed on the keyboard on other layouts (its `L()`). The key is shown wherever the action is: on
   the palette's row (a command names its `hotkeyId`, `R/commandPalette/core/types.ts`), in a button's tooltip (a row's
   close button names `CLOSE_WORKSPACE`), on the empty workspace beside each thing it can open
   (`W/components/WorkspaceEmptyState/WorkspaceEmptyState.tsx`), in the palette's foot
   (`R/commandPalette/ui/CommandPaletteFooter/CommandPaletteFooter.tsx`), and ⌘/ opens the keyboard page, with search,
   Recording… and Reset on each row (picture `apps/docs/public/images/keyboard.png`).
2. **Status at a glance: one mark a row, by priority.** An agent is ready for review, working, failed or needs input, in
   rising priority (`packages/shared/src/agent-status.ts`), rolled up from a pane to its tab and its workspace by
   `getHighestPriorityStatus` (`apps/desktop/src/shared/tabs-types.ts`). A workspace's row draws one glyph by precedence:
   the sandbox's failure, creating, working, that status, the pull request's state, idle
   (`S/components/DashboardSidebarWorkspaceItem/components/DashboardSidebarExpandedWorkspaceRow/components/DashboardSidebarWorkspaceLeadIndicator/DashboardSidebarWorkspaceLeadIndicator.tsx`).
   Ready for review is an agent that stopped and has not been looked at: it clears when the person focuses its pane
   (`W/hooks/useClearActivePaneAttention/useClearActivePaneAttention.ts`), while needs input and working stay until the
   agent moves (tabs-types.ts says so).
3. **What needs the person comes first.** The workspace switcher groups every workspace as Needs input, Completed, Running
   and Recent (`R/commandPalette/ui/WorkspaceList/utils/bucketWorkspaces/bucketWorkspaces.ts`). Held like ⌘Tab, its key
   moves down the list on each press and opens the marked workspace when the modifier is let go
   (`R/commandPalette/ui/WorkspaceList/components/WorkspaceSwitcherList/hooks/useSwitcherCycle/useSwitcherCycle.ts`;
   picture `apps/marketing/public/images/readme/agent-monitoring.gif`).
4. **One place per thing, always in view.** Three columns that never move: the workspaces, grouped by project, in a
   sidebar that only folds to a rail (⌘B); the workspace's tabs and panes; and its Files, Changes and Review on the right
   (`W/page.tsx`, `W/components/WorkspaceSidebar/WorkspaceSidebar.tsx`). The sidebar stays put as the person goes from
   workspace to workspace, and the open row scrolls itself into view (pictures `apps/docs/public/images/changes.png`,
   `apps/marketing/public/images/readme/command-palette.gif`).
5. **Progressive disclosure.** A row is one 28px line; its actions and its key show on hover and keyboard focus, and its
   details (the request, its checks, its task) in a hover card
   (`S/components/DashboardSidebarWorkspaceItem/components/DashboardSidebarExpandedWorkspaceRow/DashboardSidebarExpandedWorkspaceRow.tsx`,
   `S/components/DashboardSidebarWorkspaceItem/components/DashboardSidebarWorkspaceHoverCardContent/DashboardSidebarWorkspaceHoverCardContent.tsx`).
   The changes control shows one face for where the branch is: Commit while files changed, then Create PR, then Push
   (`W/components/ChangesControl/components/ShipControl/ShipControl.tsx`). The palette opens sub-lists in place, with Back
   on Backspace or the left arrow (`R/commandPalette/ui/CommandPalette/CommandPalette.tsx`), and the right sidebar's tab
   names fold to icons when it is narrow (WorkspaceSidebar.tsx).
6. **Quiet chrome.** A chat's state is a line of plain words under its header, "rather than chips: this sits directly under
   the pane's own header, and two rows of badges read louder than the transcript"
   (`W/hooks/usePaneRegistry/components/ChatSession/components/SessionHeader/SessionHeader.tsx`). Second lines are muted and
   small, and motion is a few loops for work in progress and short fades (`packages/ui/src/motion.css`).
7. **Nothing is a dead end.** ⌘Z outside a text field takes back the last archived workspace or closed chat
   (`R/commandPalette/ui/UndoMount/UndoMount.tsx`, `R/stores/undo-stack.ts`); ⌘⇧R reopens a closed tab; an ended terminal
   says "Session ended. Press Enter to start a new shell."
   (`W/hooks/usePaneRegistry/components/TerminalPane/components/TerminalSessionEndedFooter/TerminalSessionEndedFooter.tsx`);
   a diff that did not load says so with Retry (`W/hooks/usePaneRegistry/components/DiffPane/`); a workspace whose folder
   went says Worktree missing, with what can be done
   (`W/components/WorkspaceMissingWorktreeState/WorkspaceMissingWorktreeState.tsx`).
8. **What is offered follows where the person is.** Inside a workspace the palette puts its Workspace actions first
   (`R/commandPalette/core/sections.ts`), each command carries a `when` (types.ts), and the list puts workspaces first while
   nothing is typed and ranks workspaces and commands on one score once something is
   (`R/commandPalette/ui/CommandListView/CommandListView.tsx`, `R/commandPalette/core/rankCommands.ts`).

Where Paradev parts from Manut AI on purpose, besides item 138's six differences (`docs/paradev-parity.md`, "Where the two
apps differ on purpose"): its terminals start agents that skip their asks ("bypass permissions on" in
`apps/marketing/public/images/readme/command-palette.gif`); its needs input and failed dots ping (`animate-ping` in
`R/screens/main/components/StatusIndicator/StatusIndicator.tsx`); Enter confirms its delete dialog
(`S/components/DashboardSidebarDeleteDialog/utils/shouldConfirmDeleteDialogKey.ts`); Commit, Push, Create PR and merge run
on the person's press, with a short form at most in between (ShipControl.tsx); a failure is often a toast holding the raw error (`toast.error(errorMessage(error))` across
the renderer); and its text runs down to 10 and 11px in 28px rows.

## What the pictures of Manut AI show

Taken on 28 Nov with this repository's Playwright setup in Practice mode (the mock shell, 1280 by 820, light and dark), with
four lanes in one project: one Checked, one Tests failed, one Needs you (Kit asks to run `pnpm add qrcode`) and one Working.
The spec was a scratch file and is not kept: `e2e/kit-lanes.spec.ts`'s `startIn` with `/kit pass`, `fail`, `install` and
`slow` makes the same lanes again.

1. **The Code page with no lane** (`src/pages/CodePage.tsx`): the Lanes band with a quiet New lane link over "No lanes yet.
   Ask Kit to build or fix something.", then Terminals, Tasks and the coding plans. There is no box to ask Kit in, and no key
   is shown.
2. **The Code page with four lanes** (`src/code/Lanes.tsx`): each lane is a block with its title, "Kit · Claude Code", its
   branch, its state tag, its line, Put up for review and, in this run, the "main changed while Kit worked" note, so one lane
   takes about 250px and four do not fit on the screen. The side menu shows no lane.
3. **A lane open** (`src/sessions/SessionView.tsx`, `src/code/LanePane.tsx`): the chat fills the main column with the pane
   beside it (Put up for review, then Diff, Preview and Tests). Nothing on screen says how the other three lanes are but the
   Needs you count in the menu; reaching one is Code in the menu, then its row.
4. **A lane that asks**: the card (Run this command?, the command whole, what it does, the folder, No, Allow once, Always allow
   in this project) and "Needs you" in amber in the header. Kit's face and the activity line beside the words Needs you draw
   the working ring (`src/ui/Live.tsx`).
5. **The palette** (`src/palette/Palette.tsx`): Go to (the menu's pages) and Actions. No row shows its key and no lane is a
   row; typed in a lane's chat, "lane" finds only Search History, since New lane is offered on the Code page alone.
6. **The terminal panel** (`src/terminal/Panel.tsx`): under the chat column, which it shortens.
7. **Settings** (`src/settings/Settings.slot.tsx`): one list with Under the hood's ten pages, and no search.

## Area by area

### Navigation: where a lane is

**Paradev.** The workspaces sidebar is always there: projects as groups, workspaces as one-line rows, Pinned on top, the
open one marked, Ports at its foot and New Workspace at its head with its key (`S/`; pictures
`apps/docs/public/images/changes.png`, `apps/docs/public/images/new-workspace.png`,
`apps/docs/public/images/prompt-first.png`). ⌘B folds it to a rail. ⌘[ and ⌘] go back and forward through what was opened
(`NAVIGATE_BACK` and `NAVIGATE_FORWARD` in `R/hotkeys/registry.ts`).

**Manut AI today.** The side menu (196px, `src/sidebar/Sidebar.tsx`) has the app's pages, Needs you's count and Buddy's three
Recent threads. Lanes are listed only in the Lanes band on the Code page (`src/code/KitPanel.tsx`), and a lane opened fills
the main column, so going from one lane to another passes through the Code page (pictures 2 and 3). The Code board keeps the
Lanes band in view above the open lane's conversation, the open lane marked (`Code.dc.html`); the app does not yet. There is
no back and forward; Settings has a back arrow of its own.

**Verdict: adapt.** Lanes stay in view in the code mode, as Paradev's sidebar and the Code board both have them, and they do
it in the side menu rather than in a new column (BrandLayout: "a quiet side menu, one main column, and a right panel only
when there is detail"). While the Code row is current (the Code page or a lane open), the menu lists the lanes under Code,
grouped by project with the open project first, in the band's order and with its marks (`src/sidebar/rows.ts`: pinned on
top, settled below, snoozed and archived behind one line). Each is a menu row with its title and its one state mark (the
next areas), the open one marked as the menu marks its current row, with its More menu on hover and focus
(`src/sidebar/RowMenu.tsx`). Buddy's Recent threads give the lanes their place only while the code mode is open, and are
still on Home, History and Buddy's pages. The Lanes band on the Code page stays, for the lines and actions a menu row has no
room for. Back and forward: adopt, on a chord `src/app/keys.ts` accepts (Paradev's ⌘[ and ⌘]).

### Switching between lanes

**Paradev.** ⌘1 to ⌘9 open the sidebar's first nine workspaces (a row shows its key on hover), ⌘⌥↑ and ⌘⌥↓ the previous and
next in the sidebar's order, wrapping (`apps/docs/content/docs/keyboard-shortcuts.mdx`), and ⌘. opens the switcher: Needs
input, Completed, Running, Recent, held to cycle (principle 3).

**Manut AI today.** ⌘1 to ⌘9 open team members and are fixed; ⌘⇧] and ⌘⇧[ step through terminal sessions only
(`terminalOrder` in `src/app/shortcuts.ts`); ⌘J goes to the next ask, oldest first, in any chat; ⌘. shows or hides Details.
No key moves between lanes, and the palette lists none (picture 5; `src/palette/registry.ts`, `src/palette/groups.ts`).

**Verdict: adapt.** ⌘1 to ⌘9 stay the team's, ⌘J the asks' and ⌘. Details': those keys are learned, and Buddy's side uses
them. Lanes get Paradev's moves on keys of their own: the previous and next lane in the menu's order (Paradev's ⌘⌥↑ and ⌘⌥↓
if `keys.ts` accepts them), and a lane switcher in Paradev's order of what needs the person (Needs you, done and not looked
at, Working, then the rest by when each last moved), held to cycle on a chord `keys.ts` accepts. Each is a settable action
in its `KEY_ACTIONS`. Opening a lane from the switcher or by a key answers nothing: a lane that asks opens with its card in
view, as Answer Kit does today.

### The palette and the keys

**Paradev.** ⌘⇧K, 640px wide. Workspaces lead while nothing is typed, and once something is, workspaces and commands rank on
one score; each row shows its key; sub-lists open in place (recently viewed files, quick open, themes) with Back on Backspace
or the left arrow; `>` keeps the list to commands; the foot says ↵ Open, the switcher's key, `>` and esc
(`R/commandPalette/`). The keyboard page has search, Recording… and Reset on each row, Reset all, and Import and Export
(picture `apps/docs/public/images/keyboard.png`).

**Manut AI today.** ⌘K, with Go to, Actions, Chats and a row that carries the words to History (`src/palette/groups.ts`).
Each action presses what a button elsewhere presses and names that place, and `src/palette/registry.test.ts` fails when the
palette would approve, send, remove or pay. No row shows a key, though the Search board draws them (⌘N beside New chat, and
"⌘ K opens this menu from any screen"; `Search.dc.html`). Keys are set in Settings › General › Keyboard
(`src/settings/KeysRows.tsx`, `src/app/keys.ts`), which refuses keys macOS keeps or another action has; nothing lists every
key in one place.

**Verdict: adopt** keys where the actions are: each palette row and each button that has a key shows it (the row's tail, a
button's title and `aria-keyshortcuts`), the palette's foot says Return opens and Esc closes, and a key sheet lists every
key, settable and fixed, read only, with a link to the Keyboard list (on Paradev's ⌘/ if `keys.ts` accepts it). **Adopt**
lanes in the palette: a Lanes group first in the code mode, found by title and branch, and the open lane's actions (Open in
the editor, the pane's chips, Put up for review, which opens its ask). **Keep ours**: the palette only goes somewhere or
presses what a button elsewhere presses, and never answers an ask, removes a lane or sends anything. Paradev's palette
deletes a workspace (`R/commandPalette/ui/DeleteWorkspaceMount/DeleteWorkspaceMount.tsx`); here such a row would open the
panel where the ask is answered. Import and Export of keys are not needed while keys stay on this Mac.

**Built (item 167d, `docs/decisions/167d-keys-shown.md`).** The sheet is a settable action of its own, `key-sheet`, on ⌘/ (Ctrl+/ off
a Mac), with a search over the words and the keys, five groups (Go to, Chat, Panels, Terminals, Help), a Change on each settable
row that opens that row in Settings › General › Keyboard, and a link to the list at its foot; it is read only and holds the
keyboard while it is open, as the palette does. The palette's rows carry the person's key at their tail, a cap for each key as the
Search board draws it, only where the row does what the key does (New chat or terminal, Settings › General, and two rows added for
it, the side menu's switch and the sheet); its foot says Return, Esc and the palette's own key. Buttons name the key in their tooltip
and `aria-keyshortcuts` (Search, the side menu's Hide and Show, Settings, Details, the + menu, the terminal panel's Hide, the graph's
Full view), and the Lanes band's New lane and the empty Terminals row show the + menu's key beside what they open. Every one reads
the key the person set (`src/app/keyHints.ts`), and shows none for an action they gave none.

### An agent's state, and needing the person

**Paradev.** Principle 2's four states and the one glyph; a dot on each tab
(`W/components/NotificationStatusIndicator/NotificationStatusIndicator.tsx`); the chat's state in words (Starting, Working,
Needs input, Idle, Offline, Dead; SessionHeader.tsx); a Dock badge (`apps/docs/content/docs/agent-status.mdx`). Needs input
and failed ping, and working is a wave spinner (StatusIndicator.tsx, DashboardSidebarWorkspaceLeadIndicator.tsx). Its ask
in a chat is close to Manut AI's card: "Run this command?", the command whole, Deny, Allow for session and Allow
(`W/hooks/usePaneRegistry/components/ChatSession/components/Transcript/components/ApprovalRow/ApprovalRow.tsx`).

**Manut AI today.** A lane's state is decided once (`laneStatus` in `src/code/lane.ts`: needs you, working with its step and
time, failed, reverted, checked, tests failed, not confirmed, not run) and drawn as a tag in the brand's tones (`laneTag`).
Needs you is a page (`src/pages/NeedsPage.tsx`), a count in the menu, ⌘J and the Dock badge (`src/app/badge.ts`). An agent in
a terminal shows working and done from its own OSC 9;4 and never needs you (`src/sessions/term/engine-marks.ts`, item 152).
Nothing marks a lane that finished while the person was elsewhere. While a lane waits on its card, its chat still draws the
working ring (picture 4).

**Verdict: adopt** one mark a lane, decided once by `laneStatus`'s order and drawn the same in the menu, the band, the
palette, the switcher and the lane's header. **Adapt** ready for review: a lane whose turn ended while its chat was not on
screen is not looked at until it is opened, drawn with no fifth colour (its title in weight 600, the brand's one emphasis,
and its line saying when it finished); an ask always takes over. **Keep ours**: the Needs you mark and a failure appear and
stay still (`docs/motion.md`: approvals and errors do not bounce), only work in progress loops, colour keeps its four
meanings, and the card stays the kit's (item 85g). While a turn waits on its card it looks waiting everywhere: no working
ring turns, and the face's waiting look shows (KitFaces).

### Review

**Paradev.** Item 146 took its layout (split and unified, one file at a time, sections, a note on lines). Beside that: a
Viewed box on each file and "0/25 viewed" over the list (`W/hooks/useViewedFiles/useViewedFiles.ts`; picture
`apps/docs/public/images/changes.png`); Collapse all and Expand all; generated and binary files hidden; a large diff waiting
behind Load diff; "Unable to load diff" with Retry (`W/hooks/usePaneRegistry/components/DiffPane/`); the tab bar's changes
control, showing +746 -162 and opening the changes (`W/components/ChangesControl/ChangesControl.tsx`); and the ship
control's one face (principle 5). A note on a line offers Ask Claude Code, Reply and Resolve (picture
`apps/marketing/public/images/readme/diff-viewer.png`).

**Manut AI today.** The pane's Diff, masked (`src/code/LanePane.tsx`); since item 146 (merged 28 Nov, after the pictures
were taken) side by side or unified, one file at a time with Prev and Next, sections for the lane's commits and its
uncommitted work, a note on selected lines with the file and the range, and each lane row's commits ahead of and behind its
remote. A file past the shell's budget says "Too large to show." and a binary one says so (`src/chat/activity/Work.tsx`); a
read that fails keeps what was shown (`docs/code-editor.md`, "The pane beside a lane"). Put up for review and then Merge go through one ask each that names
exactly what goes (`src/code/Review.tsx`, `src/code/reviewAsk.ts`, item 75), from a quiet link at the pane's top (picture 3).
The Code board's top bar holds the lane's branch, its state and at most one dark button (`Code.dc.html`).

**Verdict: adopt** Viewed marks with their count, Collapse all and Expand all, lock and generated files folded with their
counts, and a diff that could not be read saying so with Try again, in the app's words. **Adapt** Viewed so that a mark
clears when its file changes again, since Kit keeps working on it (Paradev keeps a plain list of paths). **Keep ours** the
shell's budget for one diff: Paradev's Load diff would read past the cap that keeps the masking bounded, so a file past it
keeps its note. **Adapt** the ship control as the lane's next step: one dark button in the lane's top bar, as the Code
board draws it, naming the step the branch is at (Put up for review, then Merge once its request is open), each press opening
its one ask, the request's state beside it. **Keep ours**: no Commit button (commits are Kit's, through the dial), no push or
merge by a press alone, and no Discard changes in the diff (Rewind and Bring it back are the ways back).

### Panes and terminals

**Paradev.** Each workspace has tabs of panes (terminal, chat, browser, changes, files): ⌘D, ⌘⇧D and ⌘E split, ⌘⇧0 evens the
splits, ⌘W closes a pane and ⌘⇧R reopens a closed tab, ⌘⌥← and ⌘⌥→ move between tabs. The right sidebar is dragged between
240 and 640px and its width remembered; ⌘L shows or hides it, and ⌘⌃← and ⌘⌃→ move between its tabs (`W/page.tsx`,
`R/hotkeys/registry.ts`; pictures `apps/docs/public/images/agents.png`, `apps/docs/public/images/terminal.png`). An ended
shell starts again on Enter (principle 7).

**Manut AI today.** The pane beside a lane takes flex room from 380px up to 640px and goes under the chat below 820px; its
chips are pressed only (`src/code/LanePane.tsx`). The bottom terminal panel (Ctrl+`, tabs of up to four panes,
`src/terminal/Panel.tsx`, `src/terminal/layout.ts`) and sessions side by side (`src/sessions/SplitView.tsx`); ⌘W closes the
focused split pane; Resume and Restart start a dead agent again.

**Verdict: adopt** the pane dragged to its width and kept on this Mac (a double click resets it, as item 137's side menu),
a key to show or hide it and keys for Diff, Preview and Tests, the chip last picked kept for each lane, split keys for the
terminal panel, each a chord `keys.ts` accepts, and Return to start an ended shell again. **Keep ours**: terminals in the
bottom panel (VS Code's place, and nearer the brand's one main column than Paradev's tabs of everything), the pane's place,
and an agent's Resume and Restart as presses.

### Notifications

**Paradev.** One notification for each source, a newer one replacing the older; a click shows the window and that exact
pane; an inline Reply (`apps/desktop/src/lib/trpc/routers/notifications.ts`); ringtones chosen in Settings; toasts for results
and errors.

**Manut AI today.** Every notification goes through `@manut/notify-rules` (`src/lib/notify.ts`, `src/lib/outside.ts`): quiet
hours, Hide details, and Approve only when the body is the exact action, seen whole, pressed through the card's own handler;
Look opens the app on the request. One toast, with Undo (`src/sessions/CloseToasts.tsx`).

**Verdict: keep ours.** What a notification may carry and do is already narrower than Paradev's, by design: an inline Reply
could answer a question unseen, and a notification settles an ask only by the card's own path.

### Settings for developers

**Paradev.** Groups (Personal, Editor & Workflow, Cloud, Organization;
`R/routes/_authenticated/settings/utils/settingsSections/settingsSections.ts`) and one search over every setting, each
page counting its matches, the words marked, and "N results for …" with Clear
(`R/routes/_authenticated/settings/utils/settings-search/settings-search.ts`,
`R/routes/_authenticated/settings/components/SearchResultsBanner/SearchResultsBanner.tsx`). The keys have a page of their
own.

**Manut AI today.** One column, the everyday pages first and the developer pages under Under the hood
(`src/settings/pages.ts`, the Settings board); the keys in General; no search (picture 7).

**Verdict: adopt** the search: a field over Settings' list that finds rows on every page (Under the hood's included), counts
them on each page, shows only the matching rows with the words marked, and says how many, with Clear; ⌘F in Settings goes to
it. **Keep ours**: one column with Under the hood (`docs/design-audit.md`, finding 4), and the keys in General with the key
sheet one press away.

### First run

**Paradev.** A few screens, one choice each: the language, how the person runs agents (Chat or Terminal, with a sketch of
each), a first project (a folder, or what other tools had), GitHub; "You can change this later in Settings."
(`R/routes/_authenticated/onboarding/`).

**Manut AI today.** The first run is the shop owner's: Welcome, Your shop, One channel, Your team (`src/onboarding/flow.ts`).
A developer meets the Code page's empty state (picture 1).

**Verdict: adapt.** A developer's first visit to the Code page asks three things in place, each skippable and each in
Settings later: a project (Add a folder, or New project, item 100b), the agent (those Settings › Providers finds, each with
its sign-in state, and Bring over Claude Code and Codex work, item 101e), and how much Kit does alone (the dial, with Asks
every time chosen and "Going live always asks, at every level"). Paradev's Chat or Terminal stays the + menu's choice. No
choice starts an agent that does not ask.

### Empty, loading and error states

**Paradev.** The empty workspace lists what can be opened, each with its key
(`W/components/WorkspaceEmptyState/WorkspaceEmptyState.tsx`); the new workspace page asks "What should we build next?" with
three suggestions and one box with the agent, model and effort, the project and branch under it
(`R/routes/_authenticated/components/DashboardNewWorkspaceModal/`; picture `apps/docs/public/images/prompt-first.png`);
lists say "No results" and the like; skeletons and spinners while loading; errors as toasts with the raw error; Worktree
missing with Delete workspace, Refresh and Browse workspaces.

**Manut AI today.** StatesSystem's words, "This page did not load. Nothing was changed. Try again.", with the raw error under
a shut Details (`src/pages/load.ts`); loading rows in the Loading shimmer (`src/pages/Loading.tsx`); "No lanes yet" with the
New lane link (picture 1); "Kit has not changed any file yet." in the pane.

**Verdict: adopt** an empty Code page that offers the next step: a box, "What should Kit build?", with the project, the
branch it starts from and the agent with its approval level on chips under it, and a few suggestions that fill the box
unsent. Sending starts the lane exactly as the + menu's Chat with Kit does (`src/sessions/newMenu.ts`), in the agent's Ask
mode. A new lane's draft lists what can be opened there, each with its key. **Keep ours**: failures worded for people with
Try again and the error under Details, never a toast holding the raw error, and the Loading shimmer.

### Motion and density

**Paradev.** A shimmer on working text, a wave spinner, slow spins, a 320ms fade for streamed blocks and a pulse while it
thinks (`packages/ui/src/motion.css`); needs input and failed ping; rows 28px, names 13px, second lines 11px, keys in 10px
mono.

**Manut AI today.** The Motion board's named moves (`src/theme/motion.css`, `docs/motion.md`) and the type and rhythm of
`docs/design-audit.md` (rows 44px, nothing under 12px, weight 600 the only emphasis).

**Verdict: keep ours.** Both are the brand's look, which the owner's ask keeps. Paradev's own motion is mostly what the
Motion board allows (loops only for work in progress, short fades), but for the ping. The lane rows in the menu are the menu's own rows (KitNavigation), not Paradev's 28px
ones.

## The changes and the boards they touch

The lead updates the canvas. These are the boards each change would touch, with their Dark twins where they exist.

| Change | Row | Boards |
| --- | --- | --- |
| Lanes in the side menu in the code mode, and previous and next lane | 167a | Main, KitNavigation, Code, KitLists |
| One mark a lane, not looked at, and a wait that looks waiting | 167b | KitStatus, StatesCode, KitCode, KitFaces |
| The lane switcher, and lanes in the palette | 167c | Search |
| Keys where the actions are, and the key sheet | 167d | Search, Settings, KitActions |
| The lane's next step in its top bar | 167e | Code, StatesCodeDev, KitApproval |
| The pane's width and keys, and the panel's keys | 167f | Code, BrandLayout |
| The empty Code page with its box | 167g | StatesCode, StatesSystem, KitForms |
| Review: viewed, folded, and Try again | 167h | KitCode, Code |
| Search in Settings | 167i | Settings, StatesSystem |
| A developer's first visit to the Code page | 167j | StatesCodeDev |
| Back and forward | 167k | KitNavigation |

## Lifts and dependencies

No change needs a new dependency. What may be lifted, under Paradev's MIT licence, with a credit in the file when it is:

- `R/commandPalette/core/rankCommands.ts` (130 lines; it imports only Paradev's `i18n` and its own types, and has 292 lines
  of tests on `bun:test`): ranks rows of different kinds on one score. Lifted with its tests ported to vitest, it ranks lanes and the
  palette's other rows together (167c).
- `R/commandPalette/ui/WorkspaceList/utils/bucketWorkspaces/bucketWorkspaces.ts` (116 lines) and `useSwitcherCycle.ts`: read
  for the switcher's groups and the hold to cycle, and written again over `laneStatus` and the app's palette (167c).
- `R/routes/_authenticated/settings/utils/settings-search/settings-search.ts` (2,049 lines, an entry for every setting): read
  for its shape and written again over `src/settings/pages.ts` (167i).
- `W/components/ChangesControl/components/ShipControl/ShipControl.tsx`: read for its one face; none of its presses is taken
  (167e).

Paradev stays credited in `README.md` and `CREDITS.md` as it is; a lifted file adds its own credit when it lands.

## The order

The rows are in `docs/plan.md` after row 167, in the order a developer using Kit's lanes would feel them: lanes in view
(167a), one mark and not looked at (167b), the switcher (167c), the keys (167d), the next step (167e), the pane (167f), the
empty Code page (167g), review (167h), Settings' search (167i), the first visit (167j), and back and forward (167k). Smaller
pieces went into the rows they belong to: 149 (quick open in the palette), 151 (open threads first), 152 (a terminal's
mark), 155 (ports on the menu's lane rows), 160 (a script's key shown) and 162 (the board in the switcher's order). Rows
167e, 167f and 167h build on item 146, which was being built when they were written and merged the same day.
