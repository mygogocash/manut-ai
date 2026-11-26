# Item 101d: several accounts for Grok and pi, as Claude Code and Codex have

## Where Grok and pi stopped short (read before the change, 27 Nov 2026)

| Part | Claude Code and Codex | Grok before | pi before | Closed by |
| --- | --- | --- | --- | --- |
| Settings, accounts listed by the shell (`accounts::LISTED_CLIS`, every mode) | listed | not listed (only the bridge's list had it, so Practice and Connected hid it) | same | both listed |
| Added, named, removed, picked for new sessions (`add`, `set_label`, `remove`, `set_active`) | yes | refused ("unknown cli") | refused | follows the list |
| Signed in (`fixed_args` `Login`, `Logins::start`) | the CLI's own `auth login` / `login`, run in the account folder, output streamed | none: `SIGN_IN` was `null` | none: `SIGN_IN` was `session`, disabled with "Soon" | Grok: `grok login`. pi: its own `/login`, in a pi terminal opened as the account |
| Sign-in read back (`status`, `signed_in_here`) | status command, or Codex's `auth.json` stat | none | none | `auth.json` stat for both, never opened |
| `session_cli` (which agent takes an account) | claude, codex | grok (already, item 101b) | none | pi added |
| `session_env_for` (the account's home variable on a new or restarted terminal or chat) | works | worked | `pi` returned no env, so a chat or terminal always ran as the person's own home | follows `session_cli` |
| Account picker where a session starts (`SESSION_CLI`, `ACCOUNT_CLI`, "as <name>", the account kept on the session and sent again after a restart) | yes | yes (item 101b) | none | pi added in both tables |
| Shared configuration into an added account (`shared_names`, `prepare`) | skills, commands, rules, settings copy | none | none | Grok: its documented `AGENTS.md`, `skills`, `commands`, `personas`. pi: none, see below |
| Grok chat refuses unless its settings ask | n/a | read `$GROK_HOME` from the chat's own env, tested only with a hand-made env | n/a | a test now goes from the chosen account through `session_env_for` and `prepare` to the refusal |
| Usage and limits per account (item 106's readers) | read | none (no reader of Grok's usage exists, for the person's own home either) | none | not closed, see below |

## Decisions

| Date | Decision | Why | By | Undo by |
| --- | --- | --- | --- | --- |
| 27 Nov 2026 | Grok and pi have no usage or limit reader, so their rows show no usage line, no ring and are never limited (auto-switch never moves off them) | Item 106's readers parse Claude Code's and Codex's own session files and records. No documented usage or limit source of Grok or pi was found: Grok's documentation names `sessions/` as SQLite and lists no quota, and pi is not installed on this Mac to read. A guessed reader would show a wrong number | Claude | Add a reader beside `outside_use.rs` and give the rows `usage` once a source is documented |
| 27 Nov 2026 | An account is read as signed in when its folder holds `auth.json` (a stat, the file is never opened), for Grok and pi; no status command is run | Grok's documentation says `grok login` writes `$GROK_HOME/auth.json`. `grok models` would also say signed in through an `XAI_API_KEY` in the app's own environment, which would read every account as signed in. A file stat is per folder, so a token in one account's folder is never read for another. pi's `auth.json` in `PI_CODING_AGENT_DIR` is from its public documentation, not seen here (pi is not installed on this Mac, its shim cannot run) | Claude | `signed_in_here` and `status` in `accounts.rs` |
| 27 Nov 2026 | A pi account without `auth.json` reads "Not signed in" but can still be picked for new sessions; a Grok account cannot | pi can also be signed in by an API key in its environment, which no folder shows, so its sign-in cannot be told from the folder. Grok's own `XAI_API_KEY` fallback is the person's environment, which every account shares | Claude | `disabled` on the "Use for new sessions" row in `AccountsPage.tsx` |
| 27 Nov 2026 | pi's added account is signed in through a pi terminal opened as that account, where the person types pi's own `/login`; Manut AI runs no sign-in line for pi and shows no "not signed in" word on pi's row in the + menu | pi's sign-in is its `/login` slash command (the app's own pi chat says so when pi is signed out); `pi --help` could not be read here (pi is not installed). Nothing is typed for the person | Claude | `SIGN_IN.pi` in `rules.ts`, `NO_SIGNED_OUT_WORD` in `signedOut.ts` |
| 27 Nov 2026 | Grok's added account shares `AGENTS.md`, `skills`, `commands` and `personas` of the person's own `$GROK_HOME`, as links, and never `config.toml`, `auth.json` or `mcp_credentials.json` | Grok's file-locations table and skills page name those four as user configuration. `config.toml` holds the permission mode (this Mac's says always-approve, which would stop the account's chats) and can hold MCP credentials, so each added account keeps Grok's own default (ask) | Claude | `shared_names` in `accounts.rs` |
| 27 Nov 2026 | pi shares nothing into an added account | pi's folder layout could not be read here, and a guessed name could link a credential file. Item 72's rule is an allow-list of names a CLI's own documentation lists | Claude | `shared_names` in `accounts.rs` once pi's documentation is read |
| 27 Nov 2026 | oh-my-pi (`omp`) is not given accounts | Its credentials live in `agent.db` (a database, seen on this Mac by name only), not a file a stat can tell, and the brief names Grok and pi | Claude | Add `omp` to `session_cli`, `LISTED_CLIS` and `ACCOUNT_CLI` with its own reading |
