# T3 Code's features, and what Manut AI has of them (26 Nov 2026)

On 26 Nov the owner pasted the features a video names for T3 Code and asked which Manut AI has, and for a plan for the
rest. Two read-only surveys checked each one against the code and `docs/plan.md` that morning; nothing here is from
memory. Of 71 features, Manut AI has 12, has one built and switched off, has part of 26, and has none of 32. The plan's
rows for the rest are items 94 to 111.

T3 Code is MIT licensed (`pingdotgg/t3code`), so its code may be lifted with a credit, as items 72 to 77 did.

Words used: **has** (works today), **part** (some of it), **off** (built, switched off), **no** (nothing built). "Asks
first" means the one ask path (`packages/approval-core`).

## Where the two apps differ on purpose

T3 Code is for a developer running many coding threads on many machines. Manut AI is for a shop owner with a team that
asks before anything public, costly or irreversible, and a code editor beside it. Three things follow, and the plan
keeps them:

- Whatever an agent, a webhook, another app or another machine starts still asks the person as it would in a chat.
  No feature below adds a way round the ask.
- The look is the brand's one look (`docs/design-audit.md`: no accent to pick). Themes for the whole app are a
  decision for the owner, not a default.
- Other machines, a tunnel and a public address cost money or open the Mac to the network, so each is built switched
  off and the owner turns it on.

## The basics

| Feature | Today | Plan |
| --- | --- | --- |
| Open source; you bring your own AI subscriptions | part: the person's own CLI sign-ins, no model key of ours. No LICENSE file | 111 (owner: the licence) |
| Desktop app | has (Mac, 0.1.1) | |
| A web app against your own instances | part: `apps/web` is the shop owner's pages and the phone app, not a front end to a Mac | 108 |
| iOS and Android apps | part: an installable web app; the phone's Your Mac tab is item 78c | 111 |
| macOS | has (Apple silicon and Intel, unsigned until the Apple secrets) | |
| Linux | part: the code and CI tests are there, no build is released | 111 |
| Windows, Windows ARM | part: an installer builds by hand and is not published; no ARM | 111 |
| Stable and nightly channels | part: a signed in-app updater, one channel | 111 |
| Imports your threads and projects on first launch | part: recent Claude Code and Codex conversations can be continued; no first-launch import | 101 |
| Thread switching on a bad connection | no (only the phone link's catch-up) | 108 |

## Agents and models

| Feature | Today | Plan |
| --- | --- | --- |
| Codex, Claude Code, Cursor, Grok, OpenCode, Antigravity, Muse Code, Pi | part: all but Muse Code; Grok is a terminal only; Cursor and Antigravity never run as a chat | 101 |
| The ACP registry, and any ACP agent by hand | part: any ACP agent by hand (Settings, Providers); seven fixed rows, no registry | 101 |
| Reuses installed agents and their sign-ins | has | |
| Several accounts of one provider | part: Claude Code and Codex; not Grok or pi; off on Windows | 101 |
| Pick the model that writes titles, commit messages and PR words | part: chat titles and PR words by Claude Code only, off by default; no commit messages | 96 |

## Orchestration

| Feature | Today | Plan |
| --- | --- | --- |
| Sub-agents across agents and models from one prompt | part: cards show an agent's own subagents; the app starts none | 102 |
| A worktree for each thread | has (lanes, Settings, Worktrees) | |
| Agents open, manage and message other threads | part: the fork's thread cards work in Practice only | 102 |
| Drag a thread into another for its context | no | 97 |
| The app as an MCP server that other apps drive | no (an MCP server for computer use only) | 103 |
| Hand a thread to another agent mid-way | no | 97 |
| Annotations on a selection, sent with the next message | no | 97 |

## Other machines

| Feature | Today | Plan |
| --- | --- | --- |
| A server mode with a small web app | no | 108 |
| Choose the machine for a thread; load balancing | no | 108 |
| A tunnel, Tailscale, several routes a machine | part: the relay phone link is built and off; Tailscale's state is read, its road waits (78f) | 78, 108 |
| A remote terminal | no (a phone may make six requests, none a terminal) | 108 |
| A diagnostics page for each machine | no | 105, 108 |
| Machines kept for a role | no | 108 |
| One-click updates everywhere | no (this Mac's app only) | 108 |
| Copy an MCP address | no | 103 |
| Permissions for each remote connection | part: one fixed set for every phone, Face ID for each Allow | 108 |
| Threads started by a webhook, held up to a day | no (earlier decided against; now planned, starting only a workflow the person allowed) | 109 |
| Move a project to another machine | no | 108 |
| Open in VS Code, remote too | no | 107 (local), 108 (remote) |
| A remote browser in the app | no (outposts drive a browser for the shop's team, not shown in the app) | 108 |
| Pictures and video over a remote link | no | 108 |
| Phone simulators in the app | no (item 79 said not planned) | 110 |

## The sidebar as an inbox

| Feature | Today | Plan |
| --- | --- | --- |
| Settle instead of archive, with undo | has (item 94: Undo in a toast and with ⌘Z) | 94 |
| Snooze until a time or until it finishes | has (item 94; lanes and terminals keep their marks across a restart) | 94 |
| Archive; pin | has | |
| A Working section | has, off by default (item 94) | 94 |
| Threads that wait on you rise to the top | has (Needs you) | |
| Cmd+Enter sends in the background | has (item 95): from Home, with a line that opens it; Settings swaps Enter and Cmd+Enter | 95 |
| A thread on a schedule | off (workflows, item 77b; routines for the shop's team) | 94 |
| Steer or queue, a key to swap, a default | has (item 95): Settings › General › Chat box; until the person picks, a team member's chat takes it in and a coding chat waits, as each did; Cmd+Enter does the other for one message; the held message keeps its buttons | 95 |
| Select several rows; bulk snooze, settle, new titles | part: select and bulk Pin, Snooze, Done for now, Archive in Recent and History (item 94); Write the title again is one row at a time (item 96) | 94, 96 |
| Auto-settle after some days | has (item 94: 3 days by default) | 94 |
| Several drafts; stash one | has (item 95): Drafts at the top of Home, five kept with their pictures and files; Cmd+S puts a chat's draft there, to take into any chat or project | 95 |
| Snapshot of any app with a global key | no | 104 |
| Swipes on the phone; Live Activities | no (Live Activities need a native app) | 78c, 111 |

## Pull requests and git

| Feature | Today | Plan |
| --- | --- | --- |
| A thread links the PR it opened; a PR viewer | part: lanes show their open PR, read only | 100 |
| A PR tab to review and merge, by merge readiness | part: the Tasks page lists and sorts by what needs attention; merging is from a lane, asked first | 100 |
| A thread settles when its PR merges | has, for a lane, when the host said it merged (item 94) | 94 |
| Frugal PR monitoring | part: caches and one query; no conditional requests | 100 |
| GitHub, GitLab, Bitbucket, Azure DevOps, Forgejo | part: GitHub and GitLab | 100 |
| Control worktrees; no-project threads; new project with GitHub | part: where and how; no new project | 100 |
| Project icons | no | 100 |

## In the chat, use, look and trouble

| Feature | Today | Plan |
| --- | --- | --- |
| HTML an agent draws, with scripts | part (item 98): an html or svg block of an answer shows as a drawing on Show drawing, in a closed box, without its scripts: in WebKit a sandboxed script can reach the network in ways no policy covers (`docs/security/chat-drawings.md`) | 98 |
| Files land where the agent can use them | has | |
| Use across accounts and machines, outside sessions too | part: what Manut AI starts and, with a switch, what Claude Code and Codex write for sessions run outside it, this Mac (item 106; Codex only when not compressed; other Macs are item 108) | 106 |
| Limits left for each account | has | |
| Send when the limit resets | has (item 95): a coding chat on a limited account offers Send at <time>; sent once when the account is usable, within the hour, else it asks first | 95 |
| Themes, VS Code themes, chat width and fonts | part: light and dark, text size; item 85i removes the six palettes as the brand asks | 99 (owner) |
| Keybindings you set | no | 99 |
| Settings for a project or an environment | part: Kit's level, rules and folders for a project | 99 |
| A command that gathers what is wrong for an agent to fix | no | 105 |
| Computer use (T3 Code has none) | has, never run against a real window | |
| Voice | has, never tried with a real microphone | |
| A command palette | has | |

## The order

1. What a person meets every day and needs nothing from the owner: the inbox (94), the chat box (95), titles and
   words (96), context between threads (97), drawings in the chat (98), pull requests (100).
2. Agents and trouble: more agents and import (101), report a problem (105), use everywhere (106), open in an editor
   (107), keybindings (99).
3. What must be designed first because it can act for the person: several agents on one job (102), the app as an MCP
   server (103), a snapshot key (104), webhooks (109).
4. Other machines (108) and simulators (110): a design pass first, as item 78 had, then phases; built off.
5. What the owner decides: platforms, channels, native phone apps and the licence (111), themes (99).
