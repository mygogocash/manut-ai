// The mock session host for the browser and e2e: echoes terminal typing and answers chats with the same events as the shell. Split out of host.ts (item 125c); host.ts re-exports it.
import { AGENTS, acpRow, agentDef, HERMES_LABEL, type AcpRow, type AgentId, type AgentInfo } from "./agents";
import { mockPtyOut, nextMockPty } from "./fg";
import mockAcpAgents from "./mockAcpAgents.json";
import { MockTurnFiles, type MockTurnGlobals, type TurnFilesHost } from "./turnFiles";
import { botRefusal, mockCheck, mockNewId, type CustomEntry, type CustomList, type CustomPreview, type CustomWhy } from "./custom";
import { withMine, type RegistryList } from "../settings/agents/acpRegistry";
import type { AskTool } from "../lib/protocol";
import { t } from "../i18n";
import { steersOf } from "./controls";
import { withoutHelperPolicy } from "../jobs/helperPolicy";
import { withoutReachNote } from "../jobs/reachList";
import { readHelperBrief } from "../jobs/helperBrief";
import { readLanded } from "../jobs/landingWire";
import type { DiskLevel, DiskState } from "../lib/disk";
import type { ImportApp, ImportProfile } from "./term/import";
import { type GitView } from "../code/moved";
import { MOCK_MOVED, MOCK_MOVED_ROOT } from "../code/mockMoved";
import { type KeptLane, type LaneCleaned, type LaneMade, type LaneReleased, type LaneRemoveAsk, type LaneRemoved } from "../code/laneBranch";
import { readAgentConfig, type AgentConfig } from "../settings/mcp/agentConfig";
import { readPulled, readTools, type MergeMethod, type NewProjectMade, type Pulled, type RepoAsk, type ReviewAsk, type ReviewDone, type ReviewDraft, type SourceTools } from "../code/source";
import { checkArgs, checkVars, homeVarOf, rulesOf, signinAgent, versionAgent, type ProviderPatch, type ProviderView, type SignIn } from "../settings/providers/model";
import { NO_SKIPS, type ImportFound } from "../importPast/offer";
import type { ChatInput, ChatEvent, PastChat, ConvState, PastMsg, BuddyChatInput, BuddyHost, TitleRequest, TitleWords, SessionHost } from "./host";

// ---- mock (browser, e2e) --------------------------------------------------------------------

export interface MockCall {
  op:
    | "reset"
    | "start"
    | "write"
    | "ack"
    | "resize"
    | "close"
    | "chat.start"
    | "chat.input"
    | "chat.close"
    | "file.save"
    | "file.remove"
    | "file.prune"
    | "history.save"
    | "history.read"
    | "history.remove"
    | "history.prune"
    | "history.clear"
    | "import.list"
    | "import.read"
    | "reveal"
    | "terminal"
    | "editor"
    | "main.moved"
    | "custom.preview"
    | "custom.botPreview"
    | "custom.confirm"
    | "custom.remove"
    | "registry.preview"
    | "power.busy"
    | "lane.worktree"
    | "lane.helper"
    | "lane.land"
    | "lane.takeBack"
    | "lane.patch"
    | "lane.remove"
    | "lane.root"
    | "lane.release"
    | "lane.clean"
    | "source.tools"
    | "source.pull"
    | "review.ask"
    | "title.run"
    | "title.cancel"
    | "review.settle"
    | "project.new"
    | "repo.ask"
    | "repo.settle"
    | "buddy.start"
    | "buddy.input"
    | "buddy.close"
    | "buddy.closeAll"
    | "buddy.file"
    | "providers"
    | "providerSave";
  /** editor: the id of the editor the folder `cwd` was opened in */
  editor?: string;
  /** providerSave: the fields the patch named (never a variable's value) */
  fields?: string[];
  id?: number | string;
  /** power.busy: the edge, and whether the shell lets go at once (the setting went off) */
  busy?: boolean;
  now?: boolean;
  /** ack: how many drawn bytes it acknowledges */
  bytes?: number;
  agent?: string;
  cwd?: string;
  data?: string;
  cols?: number;
  rows?: number;
  resume?: string;
  /** start: the id manut made for a new Claude Code conversation (`--session-id`) */
  sessionId?: string;
  account?: string;
  input?: ChatInput | BuddyChatInput;
  /** buddy.start: Buddy's instructions as the page handed them over */
  prompt?: string;
  session?: string;
  name?: string;
  size?: number;
  path?: string;
  keep?: string[];
  /** lane.helper: the lead lane's folder a helper lane was made from, and its job (item 102f) */
  lead?: string;
  job?: string;
  /** lane.worktree: the branch the shell made for a lane, and the one it was made from (main.moved: the one the page named) */
  branch?: string;
  base?: string;
  /** lane.worktree: where the folder was asked to be made ("" is the default) and whether it was asked to start from the remote;
   *  lane.clean: the folders a session still held */
  root?: string;
  remote?: boolean;
  held?: string[];
  /** main.moved: the paths whose two diffs were asked for */
  show?: string[];
  /** history: the terminal's key (a session id or `panel-<n>`) */
  key?: string;
  /** title.run: what was asked for, and with which model and effort ("" for the agent's own) */
  purpose?: "title" | "pull";
  titleModel?: string;
  titleEffort?: string;
  /** source.tools: the CLIs were asked again */
  fresh?: boolean;
  /** repo.settle: on a Yes, the command the mock would have run (the ask's own line) */
  command?: string;
  /** review.settle: the person's answer, and on a Yes the title and body the mock would have sent */
  yes?: boolean;
  title?: string;
  body?: string;
}

const BANNER: Record<string, string> = {
  claude: "\x1b[38;2;217;119;87m✻\x1b[0m \x1b[1mClaude Code\x1b[0m \x1b[2m(mock)\x1b[0m",
  codex: "\x1b[1m>_ Codex\x1b[0m \x1b[2m(mock)\x1b[0m",
  omo: "\x1b[1mOmO\x1b[0m \x1b[2m(mock)\x1b[0m",
  dsh: "\x1b[1mDeepSeek Harness\x1b[0m \x1b[2m(mock)\x1b[0m",
  omh: "\x1b[38;2;211;60;141m◆\x1b[0m \x1b[1moh-my-hermes\x1b[0m \x1b[2m(mock)\x1b[0m",
  pi: "\x1b[1mπ pi\x1b[0m \x1b[2m(mock)\x1b[0m",
  omp: "\x1b[1mπ oh-my-pi\x1b[0m \x1b[2m(mock)\x1b[0m",
  grok: "\x1b[1m𝕏 Grok\x1b[0m \x1b[2m(mock)\x1b[0m",
  opencode: "\x1b[1mopencode\x1b[0m \x1b[2m(mock)\x1b[0m",
};
/** A generic ACP agent's banner: its program's name, as the built-ins without art show theirs. */
const banner = (agent: AgentId) => BANNER[agent] ?? `\x1b[1m${agentDef(agent).program}\x1b[0m \x1b[2m(mock)\x1b[0m`;

/** The shell's generic ACP agents as `sessions_agents` sends them (src-tauri/src/acp_agents.rs `ACP_LIST`; a Rust
 *  test keeps this copy equal), for the mock host only: a browser has no shell to ask. */
const MOCK_ACP: readonly AcpRow[] = mockAcpAgents;
const PROMPT = "\x1b[2m›\x1b[0m ";

/** One step of a mock terminal's output: a message handed to the terminal (`feed`), or its acknowledgement. */
export interface MockFlow {
  op: "feed" | "ack";
  id: number;
  bytes: number;
}

const utf8 = new TextEncoder();

/** One message of a mock program that prints fast: 64 KiB of 64-byte lines, the size the shell hands output on in
 *  (`COALESCE_BYTES` in src-tauri/src/sessions.rs). */
const FLOOD_MESSAGE = `${"build output ".repeat(5).slice(0, 62)}\r\n`.repeat(1024);

/** What Settings › Worktrees asks of a new lane: where its folder is made ("" is the default) and whether it starts from the remote. */
export interface LaneStart {
  root: string;
  remote: boolean;
  /** Item 114: the lane is made with nobody there (a workflow by the clock). The shell then reads the repository's own config
   *  first, as the automatic pull does, and answers `config:<setting>` instead of making anything when it names a program or
   *  another address. A lane the person starts themselves never sets it. */
  unattended?: boolean;
}

/** A lane's working folder the mock shell made: its record, as lane.rs writes one. */
export interface MockLane {
  worktree: string;
  dir: string;
  branch: string;
  base: string;
  /** The developer's folder it was made from. */
  project: string;
  made: number;
  /** A helper lane's record (item 102f): its job and its lead lane's folder. */
  helper?: { job: string; lead: string };
}

export type MockGlobals = MockTurnGlobals & {
  /** Free bytes the mock's disk watch reads (src/lib/disk.ts); unset = 100 GB. */
  __manutDiskFree?: number;
  __manutPickFolder?: string | null;
  /** e2e: the icon each project folder keeps, as the shell answers it (a `data:` address); none: no folder keeps one */
  __manutProjectIcons?: Record<string, string>;
  /** e2e: folders that are there already ("empty", "full" or "file"), as New project's shell would find them; anything else is
   *  not there yet */
  __manutFolders?: Record<string, "empty" | "full" | "file">;
  /** e2e: what the new repository's ask refuses with (`not_signed_in`, ...), and what its Yes answers when it fails */
  __manutRepoAsk?: { refuse?: string; fail?: string };
  __manutSessionCalls?: MockCall[];
  /** e2e: every message a mock terminal's program printed and every acknowledgement of one, in the order they happened */
  __manutSessionFlow?: MockFlow[];
  __manutMockAgents?: AgentId[];
  /** e2e: Hermes is here and `omh` is not (the oh-my-hermes row reads "Hermes" and opens a Hermes chat) */
  __manutMockNoOmh?: boolean;
  /** e2e: the next file saves fail with this message */
  __manutFileSaveError?: string;
  /** e2e: the shell answers a history read this many ms late (a slow computer) */
  __manutMockHistoryDelay?: number;
  /** e2e: the profiles each app's prefs file holds for Settings › Terminal › Import from… (none = MOCK_IMPORT; an app
   *  left out has no prefs file) */
  __manutMockImport?: Partial<Record<ImportApp, ImportProfile[]>>;
  /** e2e: the branch of each folder (none = not a repository) */
  __manutBranches?: Record<string, string>;
  /** e2e: the names of branches that exist already, so a lane's branch of that name is made with a number after it */
  __manutMockTaken?: string[];
  /** e2e: the lanes' working folders the mock shell made (its records), as `lane_list` lists them */
  __manutLanes?: MockLane[];
  /** e2e: this computer's memory in bytes, as the shell reads `hw.memsize` (item 102h); unset = 8 GB, the smallest Mac; null = it
   *  could not be read */
  __manutMemory?: number | null;
  /** e2e: the next helper lane's folder is refused with this code, as the shell refuses one (item 102f) */
  __manutMockHelperRefused?: string;
  /** e2e: what the shell answers for helper lane `n`'s landing (item 102i), by the number its folder ends in (`-help-<n>`): its
   *  `lane_land` answer, or `{ refuse: "<code>" }` for a refusal; none: one file landed cleanly */
  __manutMockLandings?: Record<number, unknown>;
  /** e2e: what the shell refuses Take back of helper lane `n`'s landing with (`changed`, ...); none: it is taken back */
  __manutMockTakeBack?: Record<number, string>;
  /** e2e: the text of the patch kept for helper lane `n` (item 102i's Show patch), as the shell gives it, masked */
  __manutMockPatches?: Record<number, string>;
  /** e2e: how long the mock shell takes to land, in ms (none: at once) */
  __manutMockLandMs?: number;
  /** e2e: what the stand-in agent does with helper lane `n`'s brief (item 102h): one of its own commands (`/work hold`, `/approve`);
   *  none: it answers the brief at once */
  __manutMockHelpers?: Record<number, string>;
  /** e2e: how many files are changed or new in each lane's folder, and how many commits on its branch are not on its base,
   *  by the folder's worktree (none: 0) */
  __manutLaneChanged?: Record<string, number>;
  __manutLaneAhead?: Record<string, number>;
  /** e2e: how many commits on each lane's branch are on no remote, by worktree (none: 0) */
  __manutLaneUnpushed?: Record<string, number>;
  /** e2e: the remote branch (`origin/main`) a folder's base starts a lane from when asked to; a folder left out has no remote */
  __manutRemoteFrom?: Record<string, string>;
  /** e2e: what the shell says of git, gh and glab for Settings › Source control (its `source_tools` answer) */
  __manutSourceTools?: unknown;
  /** e2e: what a pull of each project's default branch answers, by folder (the shell's `source_pull` answer) */
  __manutPulled?: Record<string, unknown>;
  __manutTitleRun?: Partial<TitleWords> | { error: string };
  /** e2e: what each lane would go up for review with, by worktree: its repository, its commits' subjects, a code its ask is
   *  refused with, or the step its Yes fails at */
  __manutReview?: Record<string, { source?: "github" | "gitlab"; repo?: string; commits?: string[]; refuse?: string; fail?: { step: string; error: string }; cannot?: string; title?: string }>;
  /** e2e: what the Pull requests list's Merge asks (item 100), by `<source>:<repo>:<number>`: why it cannot merge, a code it is
   *  refused with, the branch it is from and its title; none: it can merge, from `change/<number>` */
  __manutPullMerge?: Record<string, { cannot?: string; refuse?: string; branch?: string; title?: string; base?: string }>;
  /** e2e: the Tasks mock's folders and their remotes (tasks/host.ts), which the list's Merge checks the project against */
  __manutTasks?: { remotes?: Record<string, { source: string; repo: string }> };
  /** e2e: what a merged clean-up of each project's lanes finds */
  __manutCleanMerged?: Record<string, { removed: string[]; kept: { branch: string; why: string }[]; cannot: string | null }>;
  /** e2e: how many changed files the developer's folders have, by folder: they do not come along into a lane's */
  __manutLeft?: Record<string, number>;
  /** e2e: how many of a folder's own agent settings files come along into a lane (`config`) and how many stay (`stayed`) */
  __manutConfig?: Record<string, number>;
  __manutStayed?: Record<string, number>;
  /** e2e: what the shell reads for Settings › MCP and Skills; without it, a browser has nothing to read */
  __manutAgentConfig?: unknown;
  /** e2e: what git says of each folder for the main branch moving (src/code/moved.ts; none = the canvas's project, a
   *  lane whose main moved; a folder left out: nothing to say) */
  __manutMoved?: Record<string, GitView>;
  /** e2e: these agents are an old version that never answers in chat mode (the shell's start deadline ends them) */
  __manutMockNoChat?: AgentId[];
  /** ACP agents the mock host treats as signed in (the others of MOCK_SIGNED_OUT answer -32000). */
  __manutMockSignedIn?: AgentId[];
  /** Buddy's stand-in Claude Code answers that it is not signed in. */
  __manutMockBuddySignedOut?: boolean;
  /** e2e: the Codex thread a chat resumes is gone (deleted or archived): the shell starts a new one */
  __manutMockGoneThreads?: boolean;
  /** The text the mock Claude Code suggests after a turn, when the chat was started with suggestions on (lib/suggest.ts). */
  __manutMockSuggestion?: string;
  /** e2e: Codex's own config runs without approvals and with full disk access (its thread reports
   *  `approvalPolicy: never`, `sandbox: dangerFullAccess`, as codex-12-late-step-init.jsonl) */
  __manutMockCodexUnguarded?: boolean;
  /** e2e: the editors the mock shell finds installed (none set = Visual Studio Code and Cursor; [] = no editor) */
  __manutEditors?: { id: string; label: string }[];
  /** e2e: the text the mock shell refuses an Open in editor with */
  __manutEditorFails?: string;
  /** e2e: the conversations Claude Code and Codex keep (none = the built-in ones) */
  __manutPastChats?: PastChat[];
  /** e2e: reads of those conversations, apart from the session calls (opening the + menu lists them) */
  __manutPastReads?: { op: "list" | "read" | "own" | "recent"; agent: string; cwds?: string[]; id?: string; cwd?: string; pty?: number; max?: number }[];
  /** e2e: what the shell's look for work to bring over finds (item 101e); none = nothing found */
  __manutImportFound?: ImportFound;
  /** e2e: the look for work to bring over fails with this text */
  __manutImportFails?: string;
  /** e2e: how many times the page looked for work to bring over */
  __manutImportLooks?: number;
  /** e2e: the conversation each mock pty's Codex holds open (pty id -> UUID), as a real Codex once its rollout exists */
  __manutMockCodexOwn?: Record<number, string>;
  /** e2e: the Dock / taskbar count manut last set */
  __manutBadge?: number;
  /** e2e: the mock's copy of manut's custom-agents file (`agents` of `~/.manut/custom-agents.json`, as written) */
  __manutCustomFile?: unknown[];
  /** Settings › Providers: the mock's copy of the shell's providers file, by agent id (values kept, as the shell keeps
   *  them; the page is only ever sent the names) */
  __manutProviders?: Record<string, MockProvider>;
  /** e2e: programs the mock finds on the search path, bare name -> where (absolute paths: any of the values) */
  __manutMockPrograms?: Record<string, string>;
  /** Settings › Providers: what Cursor's and Antigravity's status commands say, by agent id (null: they say nothing) */
  __manutMockSignins?: Record<string, SignIn | null>;
  /** e2e: custom agents the mock treats as signed out (the others answer) */
  __manutMockCustomSignedOut?: AgentId[];
  /** e2e: CLIs that are not on this computer: a terminal of one is refused, as the shell refuses it */
  __manutMockMissing?: AgentId[];
  /** e2e: conversations Claude Code and Codex cannot continue (the file, its account folder or the login is gone): a
   *  terminal that continues one prints the CLI's refusal and ends with code 1 at once, as the real CLI does */
  __manutMockGoneConversations?: string[];
  /** e2e: what the shell's look for a conversation's file answers, by id, whatever the mock's CLIs wrote (a file the
   *  look misses answers `absent` while the CLI still finds it); the read of its messages misses it too */
  __manutMockConvStates?: Record<string, ConvState>;
  /** e2e: Settings › Accounts accounts whose folder is gone: a conversation of one is `unknown`, and a CLI started
   *  as one runs in another home, where it finds none of its conversations */
  __manutMockGoneAccounts?: string[];
  /** e2e: how long the mock's Codex takes to refuse a conversation it cannot continue, after it set up its screen
   *  (30 ms unless told) */
  __manutMockCodexRefuseMs?: number;
  /** e2e: every look for a conversation's file */
  __manutConvChecks?: { agent: string; id: string; account?: string }[];
};

/** What the mock keeps for one agent on Settings › Providers, as the shell's file does. */
export interface MockProvider {
  off?: boolean;
  name?: string;
  path?: string;
  home?: string;
  args?: string[];
  env?: { name: string; value: string }[];
}

/** The programs the mock host finds unless a test says otherwise. */
const MOCK_PROGRAMS: Record<string, string> = { "cursor-agent": "/opt/homebrew/bin/cursor-agent", "acme-agent": "/opt/homebrew/bin/acme-agent", "stub-acp": "/usr/local/bin/stub-acp" };

/** The mock's past conversations: two Claude Code and one Codex conversation in the e2e folders. */
const MOCK_EDITORS = [
  { id: "vscode", label: "Visual Studio Code" },
  { id: "cursor", label: "Cursor" },
];

const MOCK_PAST: PastChat[] = [
  { agent: "claude", id: "aaaaaaaa-1111-4222-8333-444444444444", cwd: "/home/you/code/web-app", title: "Fix the login redirect", named: true, at: Date.now() / 1000 - 3_600 },
  { agent: "claude", id: "bbbbbbbb-1111-4222-8333-444444444444", cwd: "/home/you/code/manut", title: "Remember the word MARIGOLD for later", named: false, at: Date.now() / 1000 - 3 * 86_400 },
  { agent: "codex", id: "01a1d060-4ab7-72b2-b02b-1dbee1d5f52c", cwd: "/home/you/code/web-app", title: "Add a dark theme", named: true, at: Date.now() / 1000 - 600 },
];
const MOCK_PAST_MSGS: Record<string, PastMsg[]> = {
  "bbbbbbbb-1111-4222-8333-444444444444": [
    { role: "user", text: "Remember the word MARIGOLD for later", ts: Date.now() / 1000 - 3 * 86_400 },
    { role: "assistant", text: "Noted: MARIGOLD.", ts: Date.now() / 1000 - 3 * 86_400 + 5 },
  ],
};

/** Echoes typing, answers each line, ends on `exit` or Ctrl+D. Installed: claude, codex, omh. */
export class MockHost implements SessionHost, BuddyHost {
  readonly kind = "mock" as const;
  private next = 0;
  private live = new Map<number, { agent: string; line: string; out: (d: string) => void; exit: (c: number | null) => void; conv?: string }>();
  /** The Claude Code conversations the mock's terminals named (`--session-id`), by id: their folder, and the first
   *  line typed in them once one was (Claude Code writes a conversation on its first message). In this page's storage,
   *  so they outlive a reload as Claude Code's files outlive manut (`__manutMockClaudeConvs`). */
  private convs(): Record<string, { cwd: string; text?: string }> {
    try {
      return JSON.parse(localStorage.getItem("__manutMockClaudeConvs") || "{}");
    } catch {
      return {};
    }
  }
  private putConvs(c: Record<string, { cwd: string; text?: string }>) {
    try {
      localStorage.setItem("__manutMockClaudeConvs", JSON.stringify(c));
    } catch {
      /* no storage */
    }
  }
  constructor(private g: MockGlobals = globalThis as MockGlobals) {}

  private turns?: TurnFilesHost;
  /** Pretend folders and their snapshots (turnFiles.ts), made the first time a session keeps one. */
  get turnFiles(): TurnFilesHost {
    return (this.turns ??= new MockTurnFiles(this.g));
  }

  private log(c: MockCall) {
    (this.g.__manutSessionCalls ??= []).push(c);
  }
  async reset() {
    this.log({ op: "reset" });
    this.live.clear();
    for (const c of this.chats.values()) c.stop();
    this.chats.clear();
  }
  async agents(): Promise<AgentInfo[]> {
    const installed = this.g.__manutMockAgents ?? ["claude", "codex", "omh"];
    const noOmh = !!this.g.__manutMockNoOmh;
    const builtins: AgentInfo[] = AGENTS.map((a) =>
      a.id === "omh" && noOmh
        ? { id: a.id, label: HERMES_LABEL, mode: a.mode, path: "/home/you/.hermes/hermes-agent/venv/bin/python", via: "hermes" as const }
        : { id: a.id, label: a.label, mode: a.mode, path: installed.includes(a.id) ? `/usr/local/bin/${a.program}` : null },
    );
    const acp: AgentInfo[] = MOCK_ACP.map((r) => ({ id: r.id, label: r.label, mode: "chat", path: installed.includes(r.id) ? `/usr/local/bin/${r.program}` : null, acp: r }));
    // what Settings › Providers says of each, as the shell's look-up adds it
    const set = this.g.__manutProviders ?? {};
    return [...builtins, ...acp, ...this.customInfos()].map((a) => {
      const p = set[a.id];
      if (!p) return a;
      return { ...a, ...(p.off ? { off: true } : {}), ...(p.name ? { name: p.name } : {}), ...(p.path && a.path !== null ? { path: p.path } : {}) };
    });
  }

  // ---- Settings › Providers: the shell's checks over the mock's copy of its file (providers.rs) ---------------
  private providerView(a: AgentInfo): ProviderView {
    const p = this.g.__manutProviders?.[a.id] ?? {};
    const custom = !!a.acp && "custom" in a.acp && !!a.acp.custom;
    const builtin = !custom;
    const args = p.args ?? [];
    const fixed = a.acp?.args ?? (a.id === "claude" ? ["-p", "--input-format", "stream-json"] : a.id === "codex" ? ["app-server"] : []);
    const found = a.path;
    return {
      id: a.id,
      label: a.label,
      kind: custom ? "custom" : ["claude", "codex", "omo"].includes(a.id) ? "main" : a.acp ? "acp" : "builtin",
      mode: a.mode ?? "chat",
      off: !!p.off,
      name: p.name ?? "",
      found,
      path: p.path ?? "",
      path_ok: !p.path || Object.values(this.programs()).includes(p.path) || p.path === found,
      home_var: builtin ? (homeVarOf(a.id) ?? null) : null,
      home: p.home ?? "",
      args,
      env: (p.env ?? []).map((v) => v.name),
      takes_path: builtin,
      takes_args: builtin && !!rulesOf(a.id),
      takes_vars: builtin && a.id !== "dsh",
      version: versionAgent(a.id),
      signin: a.id === "claude" || a.id === "codex" || signinAgent(a.id),
      chat: found && (a.mode ?? "chat") === "chat" && a.id !== "dsh" ? [found, ...(custom ? (a.acp?.args ?? []) : fixed), ...(custom ? [] : args)].join(" ") : null,
      terminal: found && !custom && a.id !== "dsh" ? [found, ...args].join(" ") : null,
    };
  }
  async providers(): Promise<ProviderView[]> {
    this.log({ op: "providers" });
    // oh-my-hermes is offered nowhere (offeredAgents), so the page does not list it (providers.rs `list_here`)
    return (await this.agents()).filter((a) => a.id !== "omh").map((a) => this.providerView(a));
  }
  async providerSave(id: string, patch: ProviderPatch): Promise<ProviderView> {
    this.log({ op: "providerSave", id, fields: Object.keys(patch) });
    const all = await this.agents();
    const a = all.find((x) => x.id === id);
    if (!a) throw new Error("why:unknown");
    const view = this.providerView(a);
    const cur = this.g.__manutProviders?.[id] ?? {};
    const next: MockProvider = { ...cur };
    if (patch.off !== undefined) next.off = patch.off;
    if (patch.name !== undefined) {
      if (patch.name && !/^[\p{L}\p{N} ._+-]{1,40}$/u.test(patch.name)) throw new Error("why:name");
      next.name = patch.name;
    }
    if (patch.path !== undefined) {
      if (patch.path && !view.takes_path) throw new Error("why:path_none");
      if (patch.path && !patch.path.startsWith("/")) throw new Error("why:path_shape");
      if (patch.path && !Object.values(this.programs()).includes(patch.path)) throw new Error("why:path_run");
      next.path = patch.path;
    }
    if (patch.home !== undefined) {
      if (patch.home && !view.home_var) throw new Error("why:home_none");
      if (patch.home && !patch.home.startsWith("/")) throw new Error("why:home_shape");
      next.home = patch.home;
    }
    if (patch.args !== undefined) {
      if (patch.args.length && !view.takes_args) throw new Error("why:arg_unchecked");
      const r = checkArgs(id, patch.args);
      if (r) throw new Error(`why:${r.why}${r.what ? `:${r.what}` : ""}`);
      next.args = patch.args;
    }
    if (patch.env !== undefined) {
      const env: { name: string; value: string }[] = [];
      for (const v of patch.env) {
        const kept = v.value ?? cur.env?.find((x) => x.name === v.name)?.value;
        if (kept === undefined) throw new Error(`why:var_keep:${v.name}`);
        env.push({ name: v.name, value: kept });
      }
      const r = checkVars(id, env, view.takes_vars);
      if (r) throw new Error(`why:${r.why}${r.what ? `:${r.what}` : ""}`);
      next.env = env;
    }
    this.g.__manutProviders = { ...(this.g.__manutProviders ?? {}), [id]: next };
    return this.providerView((await this.agents()).find((x) => x.id === id)!);
  }
  /** Cursor's and Antigravity's sign-in as their status commands would say it: signed in, unless a test set
   *  `__manutMockSignins` (an id to its answer, null for one that says nothing). */
  async providerSignin(id: string): Promise<SignIn | null> {
    const a = (await this.agents()).find((x) => x.id === id);
    if (!a?.path || !signinAgent(id)) return null;
    const set = this.g.__manutMockSignins;
    if (set && id in set) return set[id] ?? null;
    return { logged_in: true, email: null };
  }
  async providerVersion(id: string): Promise<string | null> {
    const a = (await this.agents()).find((x) => x.id === id);
    if (!a?.path || !versionAgent(id)) return null;
    return ({ claude: "2.1.332", codex: "0.167.0" } as Record<string, string>)[id] ?? "1.0.0";
  }

  // ---- the person's own agents: the shell's checks over the mock's file (custom_agents.rs) --------------------
  private programs() {
    return this.g.__manutMockPrograms ?? MOCK_PROGRAMS;
  }
  /** Where `program` is: an absolute path the mock knows, or a bare name it finds. */
  private findProgram(program: string): string | null {
    const p = this.programs();
    if (program.startsWith("/")) return Object.values(p).includes(program) ? program : null;
    return p[program] ?? null;
  }
  /** The file, read and checked as the shell reads it: the agents that may run and the broken entries. */
  private loadCustom(): { agents: CustomEntry[]; broken: { id: string; why: CustomWhy }[] } {
    const agents: CustomEntry[] = [];
    const broken: { id: string; why: CustomWhy }[] = [];
    for (const v of this.g.__manutCustomFile ?? []) {
      const raw = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
      const id = typeof raw.id === "string" && /^[a-z0-9-]{1,64}$/.test(raw.id) ? raw.id : "";
      const why = mockCheck(v, (p) => Object.values(this.programs()).includes(p));
      if (why) broken.push({ id, why });
      else if (agents.some((a) => a.id === id)) broken.push({ id, why: "dup" });
      else agents.push({ ...(v as CustomEntry), install: (v as CustomEntry).install ?? "" });
    }
    return { agents, broken };
  }
  private customInfos(): AgentInfo[] {
    return this.loadCustom().agents.map((c) => ({
      id: c.id,
      label: c.label,
      mode: "chat" as const,
      path: this.findProgram(c.program),
      acp: { id: c.id, label: c.label, program: c.program, args: c.args, login: c.program, install: c.install, mark: "", continues: true, custom: true },
    }));
  }
  async customList(): Promise<CustomList> {
    return { agents: this.customInfos(), broken: this.loadCustom().broken };
  }
  async customPreview(label: string, program: string, args: string, install: string): Promise<CustomPreview> {
    this.log({ op: "custom.preview", name: label, path: program, data: args });
    return this.customCard(label, program, args.split(/\s+/).filter(Boolean), install);
  }
  /** The card the shell's `draft` makes: the checked entry, an id free in the file, the command as found now. */
  private customCard(label: string, program: string, args: string[], install: string): CustomPreview {
    const taken = (this.g.__manutCustomFile ?? []).map((v) => (v && typeof v === "object" ? String((v as { id?: unknown }).id ?? "") : "")).filter(Boolean);
    const entry: CustomEntry = { id: mockNewId(label.trim(), program.trim(), taken), label: label.trim(), program: program.trim(), args, install: install.trim() };
    const why = mockCheck(entry, (p) => Object.values(this.programs()).includes(p));
    if (why) throw new Error(`why:${why}`);
    if (taken.length >= 32) throw new Error("why:many");
    const found = this.findProgram(entry.program);
    return { entry, command: found ? [found, ...entry.args].join(" ") : null };
  }
  async customBotPreview(label: string, program: string, args: string[], install: string): Promise<CustomPreview> {
    this.log({ op: "custom.botPreview", name: label, path: program, data: args.join(" ") });
    const why = botRefusal(program);
    if (why) throw new Error(`why:${why}`);
    if (!args.every((a) => /^[A-Za-z0-9._=/:-]{1,64}$/.test(a))) throw new Error("why:args");
    return this.customPreview(label, program, args.join(" "), install);
  }
  async customConfirm(entry: CustomEntry) {
    this.log({ op: "custom.confirm", agent: entry.id });
    const why = mockCheck(entry, (p) => Object.values(this.programs()).includes(p));
    if (why) throw new Error(`why:${why}`);
    const file = this.g.__manutCustomFile ?? [];
    if (file.some((v) => (v as { id?: unknown })?.id === entry.id)) throw new Error("why:dup");
    this.g.__manutCustomFile = [...file, { ...entry }];
  }
  async customRemove(id: string) {
    this.log({ op: "custom.remove", agent: id });
    this.g.__manutCustomFile = (this.g.__manutCustomFile ?? []).filter((v) => (v as { id?: unknown })?.id !== id);
  }
  // ---- the ACP registry (item 101c): the shell's list for an Apple silicon Mac (acp_registry.rs, held equal by its
  // test), beside the mock's file; loaded only here, so the app's own bundle does not carry it ----------------------
  async acpRegistry(): Promise<RegistryList> {
    const list = (await import("../settings/agents/mockAcpRegistry.json")).default as RegistryList;
    return withMine(list, this.loadCustom().agents);
  }
  /** acp_registry.rs `preview_in`: only an offered entry has a card, drafted as a bot's draft is. Writes nothing. */
  async acpRegistryPreview(id: string): Promise<CustomPreview> {
    this.log({ op: "registry.preview", agent: id });
    const list = await this.acpRegistry();
    const o = list.agents.find((a) => a.id === id);
    if (!o) throw new Error("why:registry");
    if (o.state !== "offered") throw new Error(o.state === "there" ? "why:builtin" : o.state === "yours" ? "why:dup" : o.state === "refused" ? `why:${o.note}` : "why:registry");
    const why = botRefusal(o.program);
    if (why) throw new Error(`why:${why}`);
    const card = this.customCard(o.label, o.program, o.args, o.install);
    const { name, version, via, install, archive, sha256, website, repository, license } = o;
    return { ...card, registry: { id, name, version, via, install, archive, sha256, website, repository, license, tag: list.pin.tag } };
  }
  private disk: { level: DiskLevel; alerts: number; rev: number; heard: Set<(s: DiskState) => void> } = { level: "ok", alerts: 0, rev: 0, heard: new Set() };
  /** The shell's rules (src-tauri/src/disk.rs) on `__manutDiskFree` bytes (unset: 100 GB free): the event only when
   *  the level gets worse, better only 2 GB past a threshold. */
  async diskWatch(warnGb: number) {
    const free = this.g.__manutDiskFree ?? 100e9;
    const warn = warnGb * 1e9;
    const crit = warn < 20e9 ? warn / 4 : 5e9;
    const raw: DiskLevel = !warnGb ? "ok" : free < crit ? "critical" : free < warn ? "low" : "ok";
    const rank = { ok: 0, low: 1, critical: 2 } as const;
    const prev = this.disk.level;
    const level: DiskLevel =
      !warnGb || rank[raw] >= rank[prev] || free >= warn + 2e9 ? raw : prev === "critical" && free >= crit + 2e9 ? "low" : prev;
    this.disk.level = level;
    if (rank[level] > rank[prev]) this.disk.alerts++;
    const state: DiskState = { level, free_bytes: free, volume: "/", alerts: this.disk.alerts, rev: ++this.disk.rev };
    if (rank[level] > rank[prev]) for (const f of this.disk.heard) f(state);
    return state;
  }
  onDiskLevel(fn: (s: DiskState) => void) {
    this.disk.heard.add(fn);
    return () => void this.disk.heard.delete(fn);
  }
  async home() {
    return "/home/you";
  }
  async pickFolder(defaultPath: string) {
    const v = this.g.__manutPickFolder;
    return v === undefined ? defaultPath : v;
  }
  async start(agent: AgentId, cwd: string, cols: number, rows: number, onData: (d: string) => void, onExit: (c: number | null) => void, resume?: string, account?: string, sessionId?: string, link?: string) {
    // the shell's own refusal (sessions::terminal_env): only an oh-my-hermes terminal is told its link
    if (link !== undefined && agent !== "omh") throw new Error(`${agent} sessions are not given a terminal link`);
    const id = nextMockPty();
    this.log({ op: "start", id, agent, cwd, cols, rows, ...(resume ? { resume } : {}), ...(sessionId ? { sessionId } : {}), ...(link ? { link } : {}), ...(account ? { account } : {}) });
    if (this.g.__manutMockMissing?.includes(agent)) throw new Error(`${agentDef(agent).label} is not installed (no \`${agentDef(agent).program}\` found)`);
    // as Claude Code: `--session-id` of a conversation it wrote is refused, `--resume` of one it never wrote too
    const convs = agent === "claude" ? this.convs() : {};
    const conv = agent === "claude" ? (resume ?? sessionId) : undefined;
    // a CLI started as an account whose folder is gone runs in another home, where its conversations are not
    const elsewhere = !!account && !!this.g.__manutMockGoneAccounts?.includes(account);
    const cannot = !!resume && ((convs[resume] && convs[resume].text === undefined) || elsewhere || !!this.g.__manutMockGoneConversations?.includes(resume));
    const refusal =
      sessionId && convs[sessionId]?.text !== undefined
        ? `Error: Session ID ${sessionId} is already in use.`
        : !cannot
          ? null
          : agent === "codex"
            ? `Error: No saved session found with ID ${resume}. Run \`codex resume\` without an ID to choose from existing sessions.`
            : `No conversation found with session ID: ${resume}`;
    if (sessionId && !convs[sessionId]) this.putConvs({ ...convs, [sessionId]: { cwd } });
    // a resumed Codex holds its own conversation's rollout open again
    if (agent === "codex" && resume) (this.g.__manutMockCodexOwn ??= {})[id] = resume;
    const out = (d: string) => {
      (this.g.__manutSessionFlow ??= []).push({ op: "feed", id, bytes: utf8.encode(d).length });
      onData(d);
    };
    this.live.set(id, { agent, line: "", out, exit: onExit, ...(conv ? { conv } : {}) });
    mockPtyOut(id, out);
    setTimeout(() => {
      // a continued Claude Code shows the conversation so far (its first message) above the prompt
      const before = agent === "claude" && resume && convs[resume]?.text ? `> ${convs[resume].text}\r\n\r\n` : "";
      if (refusal === null) return out(`${banner(agent)}\r\n\x1b[2m  ${agentDef(agent).program} in ${cwd}\x1b[0m\r\n\r\n${before}${PROMPT}`);
      if (this.live.get(id)?.out !== out) return;
      // Codex sets up its screen first and looks for the conversation after that (about 1 s on a real one)
      if (agent === "codex") out("\x1b[?1049h\x1b[?2004h");
      setTimeout(
        () => {
          if (this.live.get(id)?.out !== out) return;
          out(`${agent === "codex" ? "\x1b[?2004l\x1b[?1049l" : ""}${refusal}\r\n`);
          this.live.delete(id);
          onExit(1);
        },
        agent === "codex" ? (this.g.__manutMockCodexRefuseMs ?? 30) : 0,
      );
    }, 30);
    return id;
  }
  ack(id: number, bytes: number) {
    this.log({ op: "ack", id, bytes });
    (this.g.__manutSessionFlow ??= []).push({ op: "ack", id, bytes });
  }
  async write(id: number, data: string) {
    this.log({ op: "write", id, data });
    const s = this.live.get(id);
    if (!s) throw new Error("no such session");
    for (const ch of data) {
      if (ch === "\r") {
        const line = s.line.trim();
        s.line = "";
        // Claude Code writes its conversation on the first message
        if (s.conv && line && line !== "/exit") {
          const c = this.convs();
          if (c[s.conv] && c[s.conv].text === undefined) this.putConvs({ ...c, [s.conv]: { ...c[s.conv], text: line } });
        }
        // `exit`, or a CLI's own `/exit` command, ends the program
        if (line === "exit" || line === "/exit") {
          s.out("\r\n");
          this.live.delete(id);
          setTimeout(() => s.exit(0), 10);
          return;
        }
        // `after <ms> bell|osc9|progress` / `after <ms> exit [code]` / `after <ms> flood [MiB]`: the program rings
        // (BEL, or an OSC 9 message), reports progress (OSC 9;4, not a ring), ends, or prints a lot at once (1 MiB
        // unless told, as 64 KiB messages) later, as an agent does while the person looks elsewhere
        const later = /^after (\d+) (bell|osc9|progress|exit|flood)(?: (\d+))?$/.exec(line);
        if (later) {
          s.out(`\r\n${PROMPT}`);
          setTimeout(() => {
            if (this.live.get(id) !== s) return;
            if (later[2] === "bell") return s.out("\x07");
            if (later[2] === "osc9") return s.out("\x1b]9;Needs your approval\x07");
            if (later[2] === "progress") return s.out("\x1b]9;4;1;50\x07");
            if (later[2] === "flood") {
              for (let i = 0; i < Number(later[3] ?? 1) * 16; i++) s.out(FLOOD_MESSAGE);
              return;
            }
            this.live.delete(id);
            s.exit(Number(later[3] ?? 0));
          }, Number(later[1]));
          continue;
        }
        s.out(line ? `\r\n\x1b[2m(mock) you said:\x1b[0m ${line}\r\n${PROMPT}` : `\r\n${PROMPT}`);
      } else if (ch === "\x03") {
        s.line = "";
        s.out(`^C\r\n${PROMPT}`);
      } else if (ch === "\x04") {
        this.live.delete(id);
        setTimeout(() => s.exit(0), 10);
        return;
      } else if (ch === "\x7f") {
        if (s.line) {
          s.line = s.line.slice(0, -1);
          s.out("\b \b");
        }
      } else if (ch >= " ") {
        s.line += ch;
        s.out(ch);
      }
    }
  }
  async resize(id: number, cols: number, rows: number) {
    this.log({ op: "resize", id, cols, rows });
  }
  async close(id: number) {
    this.log({ op: "close", id });
    this.live.delete(id);
  }

  // ---- chat: a scripted agent with the same events the Rust adapters emit -------------------
  private chats = new Map<number, MockChat>();
  async chatStart(agent: AgentId, cwd: string, onEvent: (ev: ChatEvent) => void, resume?: string, account?: string, session?: string, suggest?: boolean, mode?: string) {
    const id = ++this.next;
    this.log({ op: "chat.start", id, agent, cwd, ...(resume ? { resume } : {}), ...(account ? { account } : {}), ...(session ? { session } : {}), ...(mode ? { mode } : {}) });
    // as the shell's `start_mode`: a mode the agent does not offer starts nothing, and none is its careful one (item 89)
    if (mode !== undefined && !(MOCK_MODES[agent] ?? []).includes(mode)) throw new Error(MOCK_MODES[agent] ? `not a mode Manut AI offers: ${mode}` : `${agent} has no permission mode here (${mode})`);
    const c = new MockChat(agent, onEvent, resume, cwd, {
      mode: mode ?? MOCK_CAREFUL[agent],
      noChat: !!this.g.__manutMockNoChat?.includes(agent),
      // the generic ACP agents are signed out on the mock host unless a test signs them in, as on a fresh Mac; a
      // person's own agent answers unless a test signs it out
      signedOut: acpRow(agent)?.custom ? !!this.g.__manutMockCustomSignedOut?.includes(agent) : !!acpRow(agent) && !this.g.__manutMockSignedIn?.includes(agent),
      gone: agent === "codex" && !!resume && !!this.g.__manutMockGoneThreads,
      // the stand-in for Claude Code's `--prompt-suggestions`: a finished turn is followed by the one suggestion a test set (or a plain one)
      suggest: agent === "claude" && suggest === true ? (this.g.__manutMockSuggestion ?? "Now add a test for it") : undefined,
      unguarded: agent === "codex" && !!this.g.__manutMockCodexUnguarded,
    });
    this.chats.set(id, c);
    c.boot();
    return id;
  }
  async chatInput(id: number, input: ChatInput) {
    this.log({ op: "chat.input", id, input });
    const c = this.chats.get(id);
    if (!c) throw new Error("no such session");
    c.input(input);
  }
  async chatClose(id: number) {
    this.log({ op: "chat.close", id });
    this.chats.get(id)?.stop();
    this.chats.delete(id);
  }

  // ---- Buddy's chat: the same stand-in agent, on a list of its own, as the shell keeps Buddy's chats apart --------
  private buddies = new Map<number, MockChat>();
  async buddyStart(agent: AgentId, prompt: string, onEvent: (ev: ChatEvent) => void) {
    // as the shell refuses it (buddy_chat::may_answer), and only once the agent is there
    if (agent !== "claude") throw new Error(`${agent} cannot answer as Buddy`);
    if (!(this.g.__manutMockAgents ?? ["claude", "codex", "omh"]).includes(agent)) throw new Error(`${agentDef(agent).label} is not installed (no \`${agentDef(agent).program}\` found)`);
    const id = ++this.next;
    this.log({ op: "buddy.start", id, agent, prompt });
    const c = new MockChat(agent, onEvent, undefined, "/home/you/.manut/buddy/chat", { signedOut: !!this.g.__manutMockBuddySignedOut });
    this.buddies.set(id, c);
    c.boot();
    return id;
  }
  async buddyInput(id: number, input: BuddyChatInput) {
    this.log({ op: "buddy.input", id, input });
    const c = this.buddies.get(id);
    if (!c) throw new Error("no such session");
    // as the shell's `buddy_chat::check`: Buddy's own approval levels only, and a model the agent listed
    if (input.kind === "mode" && !["default", "plan"].includes(input.mode)) throw new Error("Buddy's chat takes a message, Stop, an answer, or a model, effort or approval level it offers");
    if (input.kind === "model" && !(MOCK_MODELS.claude ?? []).some((m) => m.id === input.model)) throw new Error(`${input.model} is not a model Claude Code offered in this chat`);
    c.input(input);
  }
  async buddyClose(id: number) {
    this.log({ op: "buddy.close", id });
    this.buddies.get(id)?.stop();
    this.buddies.delete(id);
  }
  async buddyCloseAll() {
    this.log({ op: "buddy.closeAll" });
    for (const c of this.buddies.values()) c.stop();
    this.buddies.clear();
  }
  async buddySaveFile(name: string, data: Uint8Array) {
    if (this.g.__manutFileSaveError) throw new Error(this.g.__manutFileSaveError);
    const dir = "/home/you/.manut/buddy/files/";
    let n = 1;
    while (this.files.has(`${dir}${n}-${name}`)) n += 1;
    const path = `${dir}${n}-${name}`;
    this.files.set(path, data);
    this.log({ op: "buddy.file", name, size: data.length, path });
    return path;
  }

  // ---- files: kept in memory under the same paths the shell would use ------------------------
  private files = new Map<string, Uint8Array>();
  async saveFile(session: string, name: string, data: Uint8Array) {
    if (this.g.__manutFileSaveError) throw new Error(this.g.__manutFileSaveError);
    const dir = `/home/you/.manut/session-files/${session}/`;
    let n = 1;
    while (this.files.has(`${dir}${n}-${name}`)) n += 1;
    const path = `${dir}${n}-${name}`;
    this.files.set(path, data);
    this.log({ op: "file.save", session, name, size: data.length, path });
    return path;
  }
  async readFile(path: string) {
    const d = this.files.get(path);
    if (!d) throw new Error("not a file Manut AI saved");
    return d;
  }
  /** History the mock shell keeps: in this page's storage, so it outlives a reload as the shell's files outlive a
   *  restart (`__manutMockHistory`). */
  private hist(): Record<string, { text: string; at: number }> {
    try {
      return JSON.parse(localStorage.getItem("__manutMockHistory") || "{}");
    } catch {
      return {};
    }
  }
  private putHist(h: Record<string, { text: string; at: number }>) {
    try {
      localStorage.setItem("__manutMockHistory", JSON.stringify(h));
    } catch {
      /* no storage */
    }
  }
  /** when history was last cleared (ms), as the shell keeps it: a write sent before then is dropped */
  private clearedAt = 0;
  async historySave(key: string, text: string, since: number) {
    this.log({ op: "history.save", key, data: text });
    if (!(since > this.clearedAt)) return;
    this.putHist({ ...this.hist(), [key]: { text, at: Date.now() / 1000 } });
  }
  async historyRead(key: string) {
    this.log({ op: "history.read", key });
    const late = this.g.__manutMockHistoryDelay;
    if (late) await new Promise((r) => setTimeout(r, late));
    return this.hist()[key] ?? null;
  }
  async historyRemove(key: string) {
    this.log({ op: "history.remove", key });
    const h = this.hist();
    delete h[key];
    this.putHist(h);
  }
  async historyPrune(keep: string[]) {
    this.log({ op: "history.prune", keep });
    this.putHist(Object.fromEntries(Object.entries(this.hist()).filter(([k]) => keep.includes(k))));
  }
  async termImportList() {
    this.log({ op: "import.list" });
    const all = this.g.__manutMockImport ?? MOCK_IMPORT;
    return (["iterm2", "terminal"] as const).filter((a) => !!all[a]);
  }
  async termImportRead(app: ImportApp) {
    this.log({ op: "import.read", key: app });
    const got = (this.g.__manutMockImport ?? MOCK_IMPORT)[app];
    if (!got) throw new Error("missing");
    return got.slice(0, 64);
  }
  async historyClear() {
    this.log({ op: "history.clear" });
    this.clearedAt = Math.max(this.clearedAt, Date.now());
    this.putHist({});
  }
  async removeFiles(session: string) {
    this.log({ op: "file.remove", session });
    for (const k of [...this.files.keys()]) if (k.includes(`/session-files/${session}/`)) this.files.delete(k);
  }
  async pruneFiles(keep: string[]) {
    this.log({ op: "file.prune", keep });
  }
  async branch(cwd: string) {
    const b = this.g.__manutBranches ?? { "/home/you/code/manut": "feat/session-controls" };
    return b[cwd] ?? "";
  }
  /** As the shell does it (src-tauri/src/lane.rs): the first name no branch has, made from the branch the folder is on, in
   *  a folder of its own under `~/.manut/lanes/<project>/<words>`, which is then on that branch; the developer's folder stays
   *  on its own. `__manutBranches` is where the folders' branches are (a folder with none is not a repository),
   *  `__manutMockTaken` the names that exist already, and `__manutLanes` the folders made, as the shell's records. */
  async laneWorktree(cwd: string, names: string[], start?: LaneStart): Promise<LaneMade> {
    const folders = (this.g.__manutBranches ??= { "/home/you/code/manut": "feat/session-controls" });
    const base = folders[cwd];
    if (!base) throw new Error("not_a_repository");
    const taken = (this.g.__manutMockTaken ??= []);
    const branch = names.find((n) => !taken.includes(n));
    if (!branch) throw new Error("taken");
    const lanes = (this.g.__manutLanes ??= []);
    const project = (cwd.split("/").filter(Boolean).pop() ?? "project").replace(/[^A-Za-z0-9._-]+/g, "-");
    const words = branch.slice(branch.lastIndexOf("/") + 1);
    const under = start?.root ? start.root.replace(/\/+$/, "") : "/home/you/.manut/lanes";
    let worktree = `${under}/${project}/${words}`;
    for (let n = 2; lanes.some((l) => l.worktree === worktree); n++) worktree = `${under}/${project}/${words}-${n}`;
    taken.push(branch);
    folders[worktree] = branch;
    lanes.unshift({ worktree, dir: worktree, branch, base, project: cwd, made: Math.floor(Date.now() / 1000) });
    this.log({ op: "lane.worktree", cwd, branch, base, path: worktree, ...(start ? { root: start.root, remote: start.remote } : {}) });
    // e2e: `__manutRemoteFrom` names the remote branch a folder's base has; without one a lane asked to start from the remote
    // says the folder has no remote
    const remoteFrom = start?.remote ? (this.g.__manutRemoteFrom?.[cwd] ?? "") : "";
    return { branch, base, dir: worktree, worktree, left: this.g.__manutLeft?.[cwd] ?? 0, from: remoteFrom, local: start?.remote && !remoteFrom ? "no_remote" : "", config: this.g.__manutConfig?.[cwd] ?? 0, stayed: this.g.__manutStayed?.[cwd] ?? 0 };
  }
  /** As the shell does it (src-tauri/src/lane_helper.rs, item 102f): only for a lane folder the mock shell made that is not itself a
   *  helper lane's, on the first `<lead>-help-<n>` no branch has, in a folder beside the lead's, its record naming the job and the
   *  lead. The snapshot itself is the shell's: here the folder is only listed. */
  async laneHelperWorktree(lead: string, job: string): Promise<LaneMade> {
    if (job.length > 40 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(job)) throw new Error("bad_job");
    const lanes = (this.g.__manutLanes ??= []);
    const rec = lanes.find((l) => l.worktree === lead);
    if (!rec) throw new Error("not_a_lane");
    if (rec.helper) throw new Error("lead_is_helper");
    const refused = this.g.__manutMockHelperRefused;
    if (refused) {
      delete this.g.__manutMockHelperRefused;
      throw new Error(refused);
    }
    const taken = (this.g.__manutMockTaken ??= []);
    const prefix = rec.branch.slice(0, rec.branch.lastIndexOf("/") + 1);
    const words = rec.branch.slice(prefix.length);
    const branch = Array.from({ length: 20 }, (_, k) => `${prefix}${words}-help-${k + 1}`).find((n) => !taken.includes(n));
    if (!branch) throw new Error("taken");
    const worktree = `${lead.slice(0, lead.lastIndexOf("/"))}/${branch.slice(prefix.length)}`;
    taken.push(branch);
    (this.g.__manutBranches ??= {})[worktree] = branch;
    lanes.unshift({ worktree, dir: worktree, branch, base: rec.branch, project: rec.project, made: Math.floor(Date.now() / 1000), helper: { job, lead } });
    this.log({ op: "lane.helper", lead, job, branch, path: worktree });
    return { branch, base: rec.branch, dir: worktree, worktree, left: 0, from: "", local: "", config: 0, stayed: 0 };
  }
  /** The number a helper lane's folder ends in (`<lead>-help-<n>`), which e2e names its answers by; 0 for no helper lane the mock
   *  shell made. */
  private helperNumber(helper: string): number {
    const rec = (this.g.__manutLanes ?? []).find((l) => l.worktree === helper);
    if (!rec) throw new Error("not_a_lane");
    if (!rec.helper) throw new Error("not_a_helper");
    return Number(/-help-(\d+)$/.exec(helper)?.[1] ?? 0);
  }
  /** As the shell lands a helper lane's work (item 102g, called by item 102i): what e2e set for its number, else one file landed. */
  async laneLand(helper: string) {
    const n = this.helperNumber(helper);
    this.log({ op: "lane.land", path: helper });
    const ms = this.g.__manutMockLandMs ?? 0;
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    const said = this.g.__manutMockLandings?.[n] as { refuse?: string } | undefined;
    if (said?.refuse) throw new Error(said.refuse);
    const got = readLanded(said ?? { outcome: "landed", files: ["src/qr.test.ts"], files_total: 1, conflicts: [], keys: [], patch: "", why: "", outside: [], error: "" });
    if (!got) throw new Error("unread");
    return got;
  }
  /** As the shell takes a landing back: refused with what e2e set for its number, else every file the landing named. */
  async laneTakeBack(helper: string) {
    const n = this.helperNumber(helper);
    this.log({ op: "lane.takeBack", path: helper });
    const refused = this.g.__manutMockTakeBack?.[n];
    if (refused) throw new Error(refused);
    const said = readLanded(this.g.__manutMockLandings?.[n]);
    const files = said?.files ?? ["src/qr.test.ts"];
    return { files: [...files], filesTotal: files.length };
  }
  /** As the shell reads a kept patch for Show patch: what e2e set for its number, else none is kept. */
  async lanePatch(helper: string) {
    const n = this.helperNumber(helper);
    this.log({ op: "lane.patch", path: helper });
    const text = this.g.__manutMockPatches?.[n];
    if (text === undefined) throw new Error("no_patch");
    const said = readLanded(this.g.__manutMockLandings?.[n]);
    return { text, bytes: text.length, cut: false, path: said?.patch || `/home/you/.manut/patches/job/${helper.split("/").pop()}.patch` };
  }
  /** As the shell reads `hw.memsize` (item 102h): what e2e set, else an 8 GB Mac. */
  async machineMemory(): Promise<number | null> {
    return this.g.__manutMemory === undefined ? 8 * 1024 ** 3 : this.g.__manutMemory;
  }
  /** A browser cannot read this computer's files: nothing, unless e2e gave a stand-in of the shell's answer. */
  async agentConfig(): Promise<AgentConfig[] | null> {
    return this.g.__manutAgentConfig === undefined ? null : readAgentConfig(this.g.__manutAgentConfig);
  }
  /** As the shell: a folder inside a checkout (a folder `__manutBranches` knows, or one below it) is refused, as is a relative one. */
  async laneRootCheck(root: string): Promise<string> {
    if (!root.startsWith("/") || root.includes("..")) throw new Error("bad_root");
    if (root === "/" || root === "/home/you") throw new Error("root_too_broad");
    const checkouts = Object.keys(this.g.__manutBranches ?? { "/home/you/code/manut": "" });
    if (checkouts.some((c) => root === c || root.startsWith(`${c}/`))) throw new Error("root_in_checkout");
    this.log({ op: "lane.root", path: root });
    return root.replace(/\/+$/, "");
  }
  /** What e2e says git, gh and glab are (`__manutSourceTools`); none: all three here, the two CLIs signed out. */
  async sourceTools(fresh = false): Promise<SourceTools> {
    this.log({ op: "source.tools", ...(fresh ? { fresh } : {}) });
    return readTools(this.g.__manutSourceTools ?? { git: { installed: true, version: "2.54.0" }, github: { installed: true, version: "2.104.0", signed_in: false, accounts: [] }, gitlab: { installed: false } });
  }
  /** What e2e says a pull of each project finds (`__manutPulled`, the shell's answer); none: the branch is up to date. */
  async sourcePull(cwd: string): Promise<Pulled | null> {
    this.log({ op: "source.pull", cwd });
    return readPulled(this.g.__manutPulled?.[cwd] ?? { done: false, why: "current", branch: this.g.__manutBranches?.[cwd] ?? "main", remote: "origin", from: "", to: "", count: 0 });
  }
  /** The mock's asks, by id, as review.rs keeps them: each answered once. */
  private asks = new Map<string, { state: "waiting" | "decided" | "withdrawn"; ask: ReviewAsk }>();
  /** What e2e says a lane would go up with (`__manutReview`, by worktree); none: one commit, on github.com/you/<project>. */
  private reviewOf(worktree: string): { source: "github" | "gitlab"; repo: string; commits: string[]; refuse?: string; fail?: { step: string; error: string }; cannot?: string; title?: string } {
    const lane = (this.g.__manutLanes ?? []).find((l) => l.worktree === worktree);
    if (!lane) return { source: "github", repo: "", commits: [], refuse: "not_a_lane" };
    const name = lane.project.split("/").filter(Boolean).pop() ?? "project";
    return { source: "github", repo: `you/${name}`, commits: ["Work in this lane"], ...(this.g.__manutReview?.[worktree] ?? {}) };
  }
  /** What e2e says a title run answers (`__manutTitleRun`: words, or `{ error }`); none: a fixed title and body. */
  async titleRun(req: TitleRequest): Promise<TitleWords> {
    this.log({ op: "title.run", purpose: req.purpose, key: req.key, titleModel: req.model, titleEffort: req.effort });
    const a = this.g.__manutTitleRun;
    if (a && typeof a === "object" && "error" in a) throw new Error(String((a as { error: unknown }).error));
    const w = (a ?? {}) as Partial<TitleWords>;
    return { title: w.title ?? "A written title", body: req.purpose === "pull" ? (w.body ?? "A written description") : "" };
  }
  async titleCancel(key: string) {
    this.log({ op: "title.cancel", key });
  }
  async reviewDraft(worktree: string): Promise<ReviewDraft | null> {
    const lane = (this.g.__manutLanes ?? []).find((l) => l.worktree === worktree);
    const r = this.reviewOf(worktree);
    if (!lane || r.refuse === "not_a_lane") throw new Error("not_a_lane");
    return { branch: lane.branch, base: lane.base, commits: r.commits, count: r.commits.length };
  }
  async reviewAsk(worktree: string, title: string, body: string): Promise<ReviewAsk> {
    const lane = (this.g.__manutLanes ?? []).find((l) => l.worktree === worktree);
    const r = this.reviewOf(worktree);
    if (!lane || r.refuse) throw new Error(r.refuse ?? "not_a_lane");
    if (r.commits.length === 0) throw new Error("no_commits");
    if (!title.trim() || /[\u0000-\u001f]/.test(title)) throw new Error("bad_title");
    const id = Array.from({ length: 32 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
    const ask: ReviewAsk = { id, kind: "open", source: r.source, repo: r.repo, remote: "origin", from: "", branch: lane.branch, base: lane.base, head: "0".repeat(40), commits: r.commits.length, uncommitted: this.g.__manutLaneChanged?.[worktree] ?? 0, title: title.trim(), body: body.replace(/\r\n/g, "\n").trimEnd(), number: 0, url: "", method: "", subject: "", message: "", dropped: 0 };
    this.asks.set(id, { state: "waiting", ask });
    this.log({ op: "review.ask", path: worktree, branch: lane.branch });
    return ask;
  }
  /** As the shell: a merge is asked only for a pull request that can merge (`__manutReview[worktree].merge`: why it cannot, or
   *  the title it has), with GitHub's own messages. */
  async reviewMerge(worktree: string, number: number, method: MergeMethod, credits = false): Promise<ReviewAsk> {
    const lane = (this.g.__manutLanes ?? []).find((l) => l.worktree === worktree);
    const r = this.reviewOf(worktree);
    if (!lane || r.refuse) throw new Error(r.refuse ?? "not_a_lane");
    if (r.cannot) throw new Error(`cannot_merge:${r.cannot}`);
    const title = r.title ?? "Work in this lane";
    const [subject, full] = method === "rebase" ? ["", ""] : method === "squash" ? [`${title} (#${number})`, r.commits.map((c) => `* ${c}`).join("\n\n")] : [`Merge pull request #${number} from ${lane.branch}`, title];
    // a browser has no shell to take the credit lines out: it takes out the one line Kit's stand-in agent signs with, so a walk
    // sees the count change
    const lines = full.split("\n");
    const kept = credits && method !== "rebase" ? lines.filter((l) => !/^co-authored-by: .*<noreply@anthropic\.com>$/i.test(l.trim())) : lines;
    const message = kept.join("\n");
    const dropped = lines.length - kept.length;
    const id = Array.from({ length: 32 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
    const ask: ReviewAsk = { id, kind: "merge", source: r.source, repo: r.repo, remote: "origin", from: r.repo, branch: lane.branch, base: lane.base, head: "0".repeat(40), commits: r.commits.length, uncommitted: 0, title, body: "", number, url: `https://github.com/${r.repo}/pull/${number}`, method, subject, message, dropped };
    this.asks.set(id, { state: "waiting", ask });
    this.log({ op: "review.ask", path: worktree, branch: lane.branch });
    return ask;
  }
  /** As the shell: the request must be of the project's own repository and able to merge (`__manutPullMerge`), and the ask names its
   *  repository and branch with GitHub's own message. */
  async reviewMergePull(folder: string, source: "github" | "gitlab", repo: string, number: number, method: MergeMethod, _credits = false): Promise<ReviewAsk> {
    const remote = this.g.__manutTasks?.remotes?.[folder];
    if (!remote) throw new Error("no_remote");
    if (remote.source !== source || remote.repo.toLowerCase() !== repo.toLowerCase()) throw new Error("not_this_project");
    const r = this.g.__manutPullMerge?.[`${source}:${repo}:${number}`] ?? {};
    if (r.refuse) throw new Error(r.refuse);
    if (r.cannot) throw new Error(`cannot_merge:${r.cannot}`);
    const branch = r.branch ?? `change/${number}`;
    const title = r.title ?? `Change ${number}`;
    const owner = repo.split("/")[0];
    const [subject, message] = method === "rebase" ? ["", ""] : method === "squash" ? [`${title} (#${number})`, title] : [`Merge pull request #${number} from ${owner}/${branch}`, title];
    const id = Array.from({ length: 32 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
    const ask: ReviewAsk = { id, kind: "merge", source, repo, remote: "origin", from: repo, branch, base: r.base ?? "main", head: "c".repeat(40), commits: 1, uncommitted: 0, title, body: "", number, url: `https://github.com/${repo}/pull/${number}`, method, subject, message, dropped: 0 };
    this.asks.set(id, { state: "waiting", ask });
    this.log({ op: "review.ask", path: folder, branch });
    return ask;
  }
  /** As the shell (new_project.rs): inside `/home/you`, not there or an empty folder, and git started in it (logged). */
  async projectNew(path: string): Promise<NewProjectMade> {
    const p = path.replace(/\/+$/, "");
    if (!p.startsWith("/") || p.split("/").some((w) => w === "." || w === "..")) throw new Error("bad_path");
    if (!p.startsWith("/home/you/")) throw new Error("outside_home");
    const there = this.g.__manutFolders?.[p];
    if (there === "full") throw new Error("not_empty");
    if (there === "file") throw new Error("not_a_folder");
    (this.g.__manutFolders ??= {})[p] = "full";
    this.log({ op: "project.new", path: p });
    return { folder: p, name: p.slice(p.lastIndexOf("/") + 1), existed: there === "empty" };
  }
  /** The new repositories' asks, by id: answered once, as review.rs's are. */
  private repoAsks = new Map<string, { state: "waiting" | "decided" | "withdrawn"; ask: RepoAsk }>();
  async repoAsk(folder: string, name: string, isPublic: boolean): Promise<RepoAsk> {
    const r = this.g.__manutRepoAsk ?? {};
    if (r.refuse) throw new Error(r.refuse);
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99})?$/.test(name.trim())) throw new Error("bad_repo_name");
    const id = Array.from({ length: 32 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
    const words = ["repo", "create", name.trim(), isPublic ? "--public" : "--private", "--source", folder, "--remote", "origin"];
    const plan = ["gh", ...words.map((w) => (/^[A-Za-z0-9_./=:@+,-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`))].join(" ");
    const ask: RepoAsk = { id, kind: "repo", repo: name.trim(), folder, visibility: isPublic ? "public" : "private", remote: "origin", plan };
    this.repoAsks.set(id, { state: "waiting", ask });
    this.log({ op: "repo.ask", path: folder, name: ask.repo });
    return ask;
  }
  async reviewSettle(id: string, yes: boolean): Promise<ReviewDone> {
    const repo = this.repoAsks.get(id);
    if (repo) {
      if (repo.state !== "waiting") throw new Error(repo.state === "decided" ? "already_decided" : "withdrawn");
      repo.state = "decided";
      this.log({ op: "repo.settle", path: repo.ask.folder, yes, ...(yes ? { command: repo.ask.plan } : {}) });
      if (!yes) return { outcome: "declined", pushed: false, url: "", number: 0, step: "", error: "" };
      const fail = this.g.__manutRepoAsk?.fail;
      if (fail) return { outcome: "failed", pushed: false, url: "", number: 0, step: "create", error: fail };
      const full = repo.ask.repo.includes("/") ? repo.ask.repo : `you/${repo.ask.repo}`;
      return { outcome: "created", pushed: false, url: `https://github.com/${full}`, number: 0, step: "", error: "" };
    }
    const e = this.asks.get(id);
    if (!e) throw new Error("not_found");
    if (e.state !== "waiting") throw new Error(e.state === "decided" ? "already_decided" : "withdrawn");
    e.state = "decided";
    this.log({ op: "review.settle", path: e.ask.branch, yes, ...(yes ? (e.ask.kind === "merge" ? { title: e.ask.subject, body: e.ask.message } : { title: e.ask.title, body: e.ask.body }) : {}) });
    if (!yes) return { outcome: "declined", pushed: false, url: "", number: 0, step: "", error: "" };
    const fail = this.reviewOf((this.g.__manutLanes ?? []).find((l) => l.branch === e.ask.branch)?.worktree ?? "").fail;
    if (fail) return { outcome: "failed", pushed: fail.step === "create", url: "", number: 0, step: fail.step, error: fail.error };
    if (e.ask.kind === "merge") return { outcome: "merged", pushed: false, url: e.ask.url, number: e.ask.number, step: "", error: "" };
    const number = 100 + this.asks.size;
    return { outcome: "opened", pushed: true, url: `https://github.com/${e.ask.repo}/pull/${number}`, number, step: "", error: "" };
  }
  async reviewWithdraw(id: string): Promise<void> {
    const r = this.repoAsks.get(id);
    if (r?.state === "waiting") r.state = "withdrawn";
    const e = this.asks.get(id);
    if (e?.state === "waiting") e.state = "withdrawn";
  }
  /** As the shell: a folder with changed files, or commits on no remote, is kept; the branch always stays. */
  async laneRelease(worktree: string): Promise<LaneReleased> {
    const lane = (this.g.__manutLanes ?? []).find((l) => l.worktree === worktree);
    if (!lane) throw new Error("not_a_lane");
    const changed = this.g.__manutLaneChanged?.[worktree] ?? 0;
    const unpushed = this.g.__manutLaneUnpushed?.[worktree] ?? 0;
    if (changed > 0) return { removed: false, kept: "changes", changed, unpushed: null };
    if (unpushed > 0) return { removed: false, kept: "unpushed", changed: 0, unpushed };
    this.g.__manutLanes = (this.g.__manutLanes ?? []).filter((l) => l !== lane);
    this.log({ op: "lane.release", path: worktree });
    return { removed: true, kept: null, changed: null, unpushed: null };
  }
  /** As the shell, from what `__manutCleanMerged` says each project's clean-up finds. */
  async laneCleanMerged(cwd: string, held: string[]): Promise<LaneCleaned> {
    this.log({ op: "lane.clean", cwd, held });
    return this.g.__manutCleanMerged?.[cwd] ?? { removed: [], kept: [], cannot: null };
  }
  /** The mock lane whose folder `dir` is, or is in. */
  private laneAt(dir: string): MockLane | undefined {
    return (this.g.__manutLanes ?? []).find((l) => dir === l.worktree || dir.startsWith(`${l.worktree}/`));
  }
  /** The repository folder `cwd` reads as: a lane's folder is a worktree of the developer's folder it was made from. */
  private repoOf(cwd: string): string {
    return this.laneAt(cwd)?.project ?? cwd;
  }
  async laneList(cwd: string): Promise<KeptLane[]> {
    const repo = this.repoOf(cwd);
    return (this.g.__manutLanes ?? [])
      .filter((l) => l.project === repo)
      .map((l) => ({ worktree: l.worktree, dir: l.dir, branch: l.branch, base: l.base, made: l.made, exists: true, changed: this.g.__manutLaneChanged?.[l.worktree] ?? 0, ahead: this.g.__manutLaneAhead?.[l.worktree] ?? 0, unpushed: this.g.__manutLaneUnpushed?.[l.worktree] ?? 0 }));
  }
  async laneProjects(): Promise<string[]> {
    return [...new Set((this.g.__manutLanes ?? []).map((l) => l.project))].sort();
  }
  /** As the shell: a folder it made goes only once what is in it is what the person saw, and its branch only when asked. */
  async laneRemove(worktree: string, ask: LaneRemoveAsk): Promise<LaneRemoved> {
    const lanes = this.g.__manutLanes ?? [];
    const lane = lanes.find((l) => l.worktree === worktree);
    if (!lane) throw new Error("not_a_lane");
    const changed = this.g.__manutLaneChanged?.[worktree] ?? 0;
    const ahead = ask.branch ? (this.g.__manutLaneAhead?.[worktree] ?? 0) : null;
    if ((changed > 0 && changed !== ask.changed) || (ask.branch && ahead !== ask.ahead && ahead !== 0)) return { removed: false, deleted: false, changed, ahead, error: null };
    this.g.__manutLanes = lanes.filter((l) => l !== lane);
    if (this.g.__manutBranches) delete this.g.__manutBranches[worktree];
    if (ask.branch) this.g.__manutMockTaken = (this.g.__manutMockTaken ?? []).filter((b) => b !== lane.branch);
    this.log({ op: "lane.remove", path: worktree, size: changed, ...(ask.branch ? { branch: lane.branch } : {}) });
    return { removed: true, deleted: ask.branch, changed: null, ahead: null, error: null };
  }
  async laneDiff() {
    // a browser reads no folder: the pane shows what the chat's events say
    return null;
  }
  async laneKeys() {
    // nor what a commit would save: a commit or a push asks
    return null;
  }
  async mainMoved(cwd: string, o: { base?: string | null; show?: string[] } = {}) {
    this.log({ op: "main.moved", cwd, show: o.show ?? [], ...(o.base ? { base: o.base } : {}) });
    // a lane's folder is a worktree of the developer's repository: the base moved there as it did for the developer
    const v = (this.g.__manutMoved ?? { [MOCK_MOVED_ROOT]: MOCK_MOVED })[this.repoOf(cwd)];
    if (!v) return null;
    // the diffs of the paths asked for, as the shell gives them (only a path both sides changed)
    const both = (o.show ?? []).flatMap((p) => v.both.filter((b) => b.path === p));
    // as the shell reads it: the branch the folder has checked out now (a lane's own in its folder), against the branch the
    // page names as the base, else the answer's own
    const branch = this.g.__manutBranches?.[cwd] || v.branch;
    return { ...v, branch, base: o.base || v.base, both };
  }
  /** As the shell answers: the address e2e gave for the folder, else none. */
  async projectIcon(cwd: string) {
    return this.g.__manutProjectIcons?.[cwd] ?? null;
  }
  async reveal(cwd: string) {
    this.log({ op: "reveal", cwd });
  }
  async openTerminal(cwd: string) {
    this.log({ op: "terminal", cwd });
  }
  async editors() {
    return this.g.__manutEditors ?? MOCK_EDITORS;
  }
  async openInEditor(cwd: string, editor: string) {
    this.log({ op: "editor", cwd, editor });
    // a spec makes the shell refuse, with the shell's own words
    const refuse = this.g.__manutEditorFails;
    if (refuse) throw new Error(refuse);
  }
  async pastChats(agent: "claude" | "codex", cwds: string[]) {
    (this.g.__manutPastReads ??= []).push({ op: "list", agent, cwds });
    const all = this.g.__manutPastChats ?? MOCK_PAST;
    return all.filter((c) => c.agent === agent && cwds.includes(c.cwd)).sort((a, b) => b.at - a.at);
  }
  /** As the shell (past_chats.rs `recent`): the newest `max` of the agent's conversations across `cwds`. */
  async pastRecent(agent: "claude" | "codex", cwds: string[], max: number) {
    (this.g.__manutPastReads ??= []).push({ op: "recent", agent, cwds, max });
    const all = this.g.__manutPastChats ?? MOCK_PAST;
    return all.filter((c) => c.agent === agent && cwds.includes(c.cwd)).sort((a, b) => b.at - a.at).slice(0, max);
  }
  /** As the shell (import_past.rs): what a spec says was found, else nothing; it reads nothing and writes nothing. */
  async importScan(): Promise<ImportFound> {
    this.g.__manutImportLooks = (this.g.__manutImportLooks ?? 0) + 1;
    if (this.g.__manutImportFails) throw new Error(this.g.__manutImportFails);
    return this.g.__manutImportFound ?? { projects: [], skipped: NO_SKIPS, partial: false };
  }
  async pastMessages(agent: "claude" | "codex", id: string, cwd: string) {
    (this.g.__manutPastReads ??= []).push({ op: "read", agent, id, cwd });
    if (this.g.__manutMockConvStates?.[id] === "absent") throw new Error("no such conversation");
    const mine = agent === "claude" ? this.convs()[id] : undefined;
    if (mine) {
      if (mine.text === undefined || mine.cwd !== cwd) throw new Error("no such conversation");
      return [{ role: "user" as const, text: mine.text, ts: 0 }];
    }
    const c = (this.g.__manutPastChats ?? MOCK_PAST).find((x) => x.agent === agent && x.id === id && x.cwd === cwd);
    if (!c) throw new Error("no such conversation");
    return MOCK_PAST_MSGS[id] ?? [{ role: "user" as const, text: c.title, ts: c.at }];
  }
  /** As the shell (`conversation_state`): a told answer first; an account whose folder is gone is `unknown`; a Claude
   *  Code conversation the mock's terminals named is there once something was said in it; anything else `unknown`. */
  async conversationState(agent: "claude" | "codex", id: string, account?: string): Promise<ConvState> {
    (this.g.__manutConvChecks ??= []).push({ agent, id, ...(account ? { account } : {}) });
    const told = this.g.__manutMockConvStates?.[id];
    if (told) return told;
    if (account && this.g.__manutMockGoneAccounts?.includes(account)) return "unknown";
    const mine = agent === "claude" ? this.convs()[id] : undefined;
    if (mine) return mine.text === undefined ? "absent" : "exists";
    return "unknown";
  }
  /** As the shell: the conversation the Codex running in pty `id` holds open (`__manutMockCodexOwn[id]`, set by the
   *  test as that process's Codex writes its rollout), and nothing once that program ended or is not Codex. */
  async codexConversation(id: number) {
    (this.g.__manutPastReads ??= []).push({ op: "own", agent: "codex", pty: id });
    const s = this.live.get(id);
    if (!s || s.agent !== "codex") return null;
    return this.g.__manutMockCodexOwn?.[id] ?? null;
  }
  async badge(count: number) {
    this.g.__manutBadge = count;
  }
  async power(busy: boolean, now: boolean) {
    this.log({ op: "power.busy", busy, now });
  }
}

const MOCK_MODELS: Record<string, { id: string; label: string; provider?: string }[]> = {
  claude: [
    { id: "opus", label: "Opus 5.5" },
    { id: "sonnet", label: "Sonnet 5.5" },
    { id: "haiku", label: "Haiku 5.5" },
  ],
  codex: [
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
    { id: "gpt-6.1-terra", label: "GPT-6.1 Terra" },
  ],
  pi: [{ id: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5" }],
  omp: [{ id: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5" }],
  // as real omo lists them on this Mac: many anthropic models, then two from another provider below the fold
  omo: [
    ...["Claude Fable 5.1", "Claude Opus 5", "Claude Opus 4.7", "Claude Sonnet 5.5", "Claude Sonnet 5", "Claude Haiku 5.5", "Claude Haiku 4.5", "Claude Opus 4.5", "Claude Sonnet 4.5", "Claude Opus 4.1", "Claude Sonnet 4", "Claude Opus 4", "Claude Haiku 4", "Claude 3.7 Sonnet"].map((label) => ({
      id: `anthropic/${label.toLowerCase().replace(/ /g, "-").replace(/\./g, "-")}`,
      label,
      provider: "anthropic",
    })),
    { id: "opengateway/gpt-6", label: "GPT-6 (gateway)", provider: "opengateway" },
    { id: "opengateway/gemini-4-carbon", label: "Gemini 4 Carbon (gateway)", provider: "opengateway" },
  ],
  opencode: [
    { id: "opencode/big-pickle", label: "OpenCode/Big Pickle" },
    { id: "opencode/beam-free", label: "OpenCode/Beam Free" },
  ],
};

/** The agents on the Agent Client Protocol adapter (OpenCode and the generic list): their cards offer Deny and Allow
 *  once only. */
const isAcp = (agent: AgentId) => agent === "opencode" || !!acpRow(agent);
/** A generic ACP agent's sign-in command, from its row (acp_chat.rs's `signed_out` names the same). */
const loginOf = (agent: AgentId) => acpRow(agent)?.login ?? "";

/** What each mock agent reports about its controls, as the real CLIs do (see agent_chat.rs). */
const MOCK_CONTROLS: Partial<Record<AgentId, { mode?: string; efforts: string[]; effort: string; commands: { name: string; description: string; hint: string; kind: "command" | "skill"; prefix: "/" | "$" }[]; max: number }>> = {
  claude: {
    mode: "default",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    effort: "high",
    commands: [
      { name: "compact", description: "Free up context by summarizing the conversation so far", hint: "<instructions>", kind: "command", prefix: "/" },
      { name: "context", description: "Visualize current context usage", hint: "", kind: "command", prefix: "/" },
      { name: "init", description: "Initialize a new CLAUDE.md file with codebase documentation", hint: "", kind: "command", prefix: "/" },
      { name: "review", description: "Review a pull request", hint: "<pr>", kind: "command", prefix: "/" },
      { name: "archify", description: "Architecture diagrams as standalone HTML (user)", hint: "", kind: "skill", prefix: "/" },
      ...Array.from({ length: 60 }, (_, i) => ({ name: `skill-${String(i + 1).padStart(2, "0")}`, description: `Sample skill ${i + 1} (user)`, hint: "", kind: "skill" as const, prefix: "/" as const })),
    ],
    max: 1_000_000,
  },
  codex: {
    mode: "",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    effort: "medium",
    commands: [{ name: "review", description: "Review a change", hint: "", kind: "skill", prefix: "$" }],
    max: 258_400,
  },
  omo: {
    efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
    effort: "medium",
    commands: [
      { name: "todo", description: "Show or edit the todo list", hint: "", kind: "command", prefix: "/" },
      { name: "skill:hyperframes", description: "Make or edit a video", hint: "", kind: "skill", prefix: "$" },
    ],
    max: 1_000_000,
  },
};
const MOCK_MODES: Partial<Record<AgentId, string[]>> = { claude: ["default", "plan", "acceptEdits"], codex: ["read-only", "ask", "auto"] };
/** A Codex mode as the approval policy and sandbox its thread reports (`codex_mode` in src-tauri/src/agent_chat.rs). */
const CODEX_MOCK_POLICY: Record<string, { approval: string; sandbox: string }> = {
  "read-only": { approval: "on-request", sandbox: "readOnly" },
  ask: { approval: "untrusted", sandbox: "workspaceWrite" },
  auto: { approval: "on-request", sandbox: "workspaceWrite" },
};
/** The mode a chat starts in when the page names none, as the shell's `careful_mode`. */
const MOCK_CAREFUL: Partial<Record<AgentId, string>> = { claude: "default", codex: "ask" };

/** One mock chat agent. `/approve` asks to run `rm -rf ./build`; `/slow` streams long enough to stop with
 *  Esc; `/exit` ends the program; `/title <name>` names the conversation as the agent; anything else gets a
 *  short answer after one tool step. A message sent while a turn runs is queued and answered after it, as Claude
 *  Code and OmO do; Stop drops it. `noChat`: an old version that never speaks its chat protocol, ended by the
 *  shell's start deadline (shortened here). `gone`: a Codex resume onto a thread that no longer exists. */
/** The agents that can take a message back (their own rewind): Claude Code and Codex. */
const MOCK_REWINDS: AgentId[] = ["claude", "codex"];

/** A real two-file edit as the Claude adapter emitted it (claude-12-work.jsonl, paths made relative). */
const MOCK_WORK = {
  thinking: ["Three small steps: a docstring on `add`, a new `mul`, ", "then list the functions in README.md."],
  todo: ["Add docstring to add() in calc.py", "Add mul(a, b) function to calc.py", "Update README.md with function list"],
  edits: [
    {
      id: "e-1",
      detail: "calc.py +2 -1",
      file: { path: "calc.py", kind: "update", lines: ["@@ -1,4 +1,5 @@", " def add(a, b):", '+    """Return the sum of a and b."""', "     return a + b", " ", " "], added: 1, removed: 0 },
    },
    {
      id: "e-2",
      detail: "calc.py +5 -2",
      file: { path: "calc.py", kind: "update", lines: ["@@ -5,3 +5,7 @@", " def sub(a, b):", "     return a - b", "+", "+", "+def mul(a, b):", "+    return a * b"], added: 4, removed: 0 },
    },
    {
      id: "e-3",
      detail: "README.md +3 -1",
      file: { path: "README.md", kind: "update", lines: ["@@ -1,3 +1,5 @@", " # calc", " ", " Tiny math helpers.", "+", "+Functions: `add(a, b)`, `sub(a, b)`, `mul(a, b)`"], added: 2, removed: 0 },
    },
  ],
  answer: "Done. `add` has a docstring, `mul(a, b)` is in calc.py, and README.md lists the functions:\n\n```python\ndef mul(a, b):\n    return a * b\n```",
};

/** What vitest prints for the canvas's project when its 14 tests pass, and when one of them fails (`/kit pass`, `/kit fail`). */
const MOCK_TESTS_PASS = [
  " ✓ tests/checkout.test.ts (6 tests) 8ms",
  " ✓ tests/promptpay.test.ts (8 tests) 11ms",
  "",
  " Test Files  2 passed (2)",
  "      Tests  14 passed (14)",
  "   Duration  2.1s",
  "",
].join("\n");
const MOCK_TESTS_FAIL = [
  " ❯ tests/promptpay.test.ts (8 tests | 1 failed) 14ms",
  "   × promptpay > locks the amount into the QR 3ms",
  "     → expected '59.00' to be '590.00' // Object.is equality",
  "",
  " FAIL  tests/promptpay.test.ts > promptpay > locks the amount into the QR",
  "AssertionError: expected '59.00' to be '590.00' // Object.is equality",
  "",
  " Test Files  1 failed | 1 passed (2)",
  "      Tests  1 failed | 13 passed (14)",
  "   Duration  2.3s",
  "",
].join("\n");

/** The plan Claude Code 2.1.323 wrote in plan mode (claude-14-plan-deny.jsonl), in English here. */
const MOCK_PLAN =
  "# Plan: add mul(a, b) to calc.py\n\n1. In `calc.py`, add `def mul(a, b): return a * b` below `sub`, two blank lines apart as the others are.\n2. In `README.md`, list the functions (`add`, `sub`, `mul`) under \"Tiny math helpers.\"\n\nCheck: `python3 -c \"from calc import mul; assert mul(3, 4) == 12\"`";

/** The change a Codex 0.167 sub-agent made (codex-15-sub-edit.jsonl), as the adapter's `diff` gives it. */
const MOCK_SUB_EDIT = [
  { path: "README.md", kind: "update" as const, lines: ["@@ -3 +3,3 @@", " Tiny math helpers.", "+", "+Functions: add, sub, mul"], added: 2, removed: 0 },
  { path: "calc.py", kind: "update" as const, lines: ["@@ -6 +6,5 @@", "     return a - b", "+", "+", "+def mul(a, b):", "+    return a * b"], added: 4, removed: 0 },
];

/** A helper block as a lead lane's agent writes one (item 102e). */
const helperBlock = (o: Record<string, unknown>) => `\`\`\`manut-helpers\n${JSON.stringify(o)}\n\`\`\``;

/** The stand-in agent's answers to `/helpers <word>` (item 102e). */
const MOCK_HELPERS: Record<string, string> = {
  two: [
    "I'll split this in two: the QR builder's tests, and the receipt's Thai date.",
    "",
    helperBlock({
      title: "Tests for the QR builder",
      brief:
        "In src/qr.ts, promptPayQR(shopId, amount) builds the PromptPay payload.\n\nWrite tests in src/qr.test.ts for 0, 59.00 and 590.00 baht, a shop ID with spaces, and a payload whose checksum is checked against CRC-16. Do not touch src/receipt.tsx. Run pnpm test src/qr.test.ts and report what you changed and how you checked it.",
      agent: "codex",
      model: "gpt-6.1",
      effort: "high",
    }),
    "",
    helperBlock({
      title: "The receipt's Thai date",
      brief: "In src/receipt.tsx the date shows as 2026-11-27. Show it in the Thai Buddhist calendar with Intl.DateTimeFormat. Do not touch src/qr.ts. Check with pnpm test src/receipt.test.ts.",
    }),
  ].join("\n"),
  mode: ["One helper lane for this.", "", helperBlock({ title: "Fix the tests", brief: "Fix every failing test.", mode: "bypassPermissions" })].join("\n"),
  approve: ["One helper lane for this.", "", helperBlock({ title: "Ship it", brief: "Merge and deploy.", approve: true })].join("\n"),
  text: ["A lead asks for helper lanes with a block like this:", "", "````", "```manut-helpers", '{"title": "x", "brief": "y"}', "```", "````", "", "This one I did myself."].join("\n"),
  many: ["Ten small parts.", "", "```manut-helpers", JSON.stringify(Array.from({ length: 10 }, (_, k) => ({ title: `Part ${k + 1}`, brief: `Do part ${k + 1} of the checkout.` }))), "```"].join("\n"),
  // three helper lanes, more than an 8 GB Mac runs at once (item 102h)
  three: [
    "Three parts that do not touch each other.",
    "",
    helperBlock({
      title: "Tests for the QR builder",
      brief: "In src/qr.ts, promptPayQR(shopId, amount) builds the PromptPay payload. Write tests in src/qr.test.ts for 0, 59.00 and 590.00 baht. Do not touch src/receipt.tsx. Run pnpm test src/qr.test.ts.",
      agent: "codex",
    }),
    "",
    helperBlock({ title: "The receipt's Thai date", brief: "In src/receipt.tsx show the date in the Thai Buddhist calendar with Intl.DateTimeFormat. Check with pnpm test src/receipt.test.ts." }),
    "",
    helperBlock({ title: "LINE share button", brief: "Add a Share to LINE button under the receipt in src/receipt.tsx that opens line.me/R/share with the receipt's link. Check with pnpm test src/receipt.test.ts." }),
  ].join("\n"),
};

/** A reach block as a coding chat's agent writes one (item 102k). */
const reachBlock = (word: string, o: Record<string, unknown>) => `\`\`\`manut-${word}\n${JSON.stringify(o)}\n\`\`\``;

/** The stand-in agent's answers to `/reach <word>` (item 102k): a read, a send and an open of the chat its list calls 1, a key a
 *  block never takes, and a chat that is not on the list. */
const MOCK_REACH: Record<string, string> = {
  read: ["I'll look at how the other lane built the QR first.", "", reachBlock("read", { chat: "1" })].join("\n"),
  send: ["The receipt lane should know the QR payload changed.", "", reachBlock("send", { chat: "1", message: "Allow. The PromptPay payload now ends with a CRC-16 checksum: please make the receipt print the last four characters under the QR." })].join("\n"),
  open: [
    "This wants a lane of its own.",
    "",
    reachBlock("open", {
      title: "Thai date on the receipt",
      brief: "In src/receipt.tsx the date shows as 2026-11-27. Show it in the Thai Buddhist calendar with Intl.DateTimeFormat. Do not touch src/qr.ts. Check with pnpm test src/receipt.test.ts.",
      agent: "codex",
    }),
  ].join("\n"),
  mode: ["Reading it in full.", "", reachBlock("read", { chat: "1", mode: "bypassPermissions" })].join("\n"),
  unlisted: ["Let me read the payments chat.", "", reachBlock("read", { chat: "Payments" })].join("\n"),
};

class MockChat {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private turn = false;
  private seq = 0;
  private waiting: string | null = null;
  /** the open approval is a subagent's (/subask) */
  private subWaiting = false;
  /** the open approval is plan mode's plan (/plan) */
  private planAsk = false;
  /** "/kit …": the command a scripted ask of Kit's (src/code/) is waiting to run, or "" */
  private kitAsk = "";
  /** the open approval is a background subagent's, asked after the turn ended (/lateask) */
  private lateAsk = false;
  /** "/subagents hold": the second subagent is still out */
  private holding = false;
  /** work Claude Code says still runs in the background (`background_tasks_changed`), and the background subagent
   *  among it (/lateask) */
  private bg = 0;
  private bgSub = false;
  private model: string;
  /** a model picked while a turn ran (Claude Code): the next turn's init confirms it */
  private next = "";
  private session: string;
  private used = 18_400;
  private queue: { text: string; id: string; images?: string[] }[] = [];
  /** "/stoplate": the command still runs after Stop and ends on its own later */
  private lateStep = "";
  private dead = false;
  /** messages this process took, for a rewind (Claude Code and Codex only) */
  private sent = 0;
  /** their bubble ids, in step, for a rewind to a turn */
  private sentIds: string[] = [];
  constructor(
    private agent: AgentId,
    private emit: (ev: ChatEvent) => void,
    resume?: string,
    private cwd = "",
    private how: { noChat?: boolean; gone?: boolean; unguarded?: boolean; signedOut?: boolean; suggest?: string; mode?: string } = {},
  ) {
    this.model = MOCK_MODELS[agent]?.[0]?.label ?? agentDef(agent).label;
    this.session = resume ?? `${agent}-mock-${Math.random().toString(16).slice(2, 10)}-0000-0000-000000000000`;
    if (agent === "claude" && !resume) this.session = "11111111-2222-4333-8444-555555555555";
    if (agent === "opencode" && !resume) this.session = "ses_e34e28c01ffeKlpLA61p3XV1cy";
    // the id a real OmO 5.1.56 session reported (its subagents' records are keyed by it; mock.sessionRun agent omo)
    if (agent === "omo" && !resume) this.session = "01a1ce7b-1c30-7e45-8913-aa00b3b32296";
    if (how.gone) this.session = `codex-mock-${Math.random().toString(16).slice(2, 10)}-0000-0000-000000000000`;
    // DeepSeek Harness names its session `session-<uuid>` and reports no model in its headless stream
    if (agent === "dsh") {
      if (!resume) this.session = "session-8c11e2bc-9f55-4bcb-a597-19ea472184e8";
      this.model = "";
    }
  }
  private at(ms: number, fn: () => void) {
    this.timers.push(setTimeout(fn, ms));
  }
  boot() {
    if (this.how.noChat) {
      // the shell's start deadline (agent_chat.rs START_DEADLINE): no protocol line came, so it ends the session
      const why = `${agentDef(this.agent).label} did not answer in chat mode; it may be an old version: update it, then Restart.`;
      this.timers.push(
        setTimeout(() => {
          this.dead = true;
          this.emit({ event: "session.error", kind: "no_chat_mode", message: why });
          if (this.turn) this.emit({ event: "turn.end", outcome: "error", error: why });
          this.turn = false;
          this.emit({ event: "exit", code: null, error: why });
        }, 600),
      );
      return;
    }
    if (this.how.signedOut) {
      // `session/new` answered -32000: acp_chat.rs says so once, with the row's sign-in command; manut ends it
      this.at(40, () => {
        const why = `${agentDef(this.agent).label} is not signed in. Run \`${loginOf(this.agent)}\` in a terminal and sign in.`;
        this.emit({ event: "session.error", kind: "signed_out", message: why, login: loginOf(this.agent) });
        if (this.turn) {
          this.turn = false;
          this.emit({ event: "turn.end", outcome: "error", error: why, signed_out: true, login: loginOf(this.agent) });
        }
        this.dead = true;
      });
      return;
    }
    this.at(20, () => {
      if (this.how.gone) this.emit({ event: "session.note", kind: "new_conversation", text: "The earlier Codex conversation was not found; a new one started." });
      const c = MOCK_CONTROLS[this.agent];
      // the mode it started in, named at the start (item 89), as Claude Code's initialize and Codex's thread report it
      const mode = this.how.unguarded ? undefined : (this.how.mode ?? c?.mode);
      this.emit({ event: "session.info", agent_session: this.session, ...(this.model ? { model: this.model } : {}), ...(c ? { effort: c.effort } : {}), ...(mode !== undefined ? { mode } : {}) });
      // the thread's own approval policy and sandbox, as the Codex adapter reports them: the started mode's, unless a test
      // stands in for a Codex whose own config won over them
      if (this.agent === "codex")
        this.emit({ event: "session.info", ...(this.how.unguarded ? { approval: "never", sandbox: "dangerFullAccess", mode: "" } : CODEX_MOCK_POLICY[mode ?? "ask"]) });
      this.emit({ event: "session.models", options: (MOCK_MODELS[this.agent] ?? []).map((m) => ({ ...m, detail: "" })) });
      if (c) {
        this.emit({ event: "session.efforts", levels: c.efforts });
        this.emit({ event: "session.commands", commands: c.commands });
        this.emit({ event: "session.usage", used: this.used, max: c.max });
      }
      // the agent's own commands and skills (ACP `available_commands_update`), as acp_chat.rs sends them
      if (this.agent === "opencode")
        this.emit({ event: "session.commands", commands: ["init", "review"].map((name) => ({ name, description: "", hint: "", kind: "command", prefix: "/" })) });
    });
  }
  stop() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }
  private end(outcome: "done" | "interrupted" | "ended" | "error", error?: string) {
    if (!this.turn) return;
    this.stop();
    this.turn = false;
    this.waiting = null;
    const next = this.queue;
    this.queue = [];
    // Stop drops what waited (OmO clears its queue; Codex never recorded it)
    if (outcome === "interrupted") for (const q of next) this.emit({ event: "message.dropped", id: q.id });
    this.emit({ event: "turn.end", outcome, ...(error ? { error } : {}) });
    // Claude Code's predicted next prompt follows a turn that finished well (when the chat was started asking for it)
    if (outcome === "done" && this.how.suggest) this.emit({ event: "suggestion", text: this.how.suggest });
    if (MOCK_REWINDS.includes(this.agent)) this.emit({ event: "session.info", rewind: this.sent > 0 });
    const c = MOCK_CONTROLS[this.agent];
    if (c) {
      this.used += 6_200;
      this.emit({ event: "session.usage", used: this.used, max: c.max });
    }
    // a finished turn takes what was sent during it as the next turn
    if (outcome === "done" && next.length) {
      const [first, ...rest] = next;
      this.queue = rest;
      this.at(80, () => {
        this.emit({ event: "message.taken", id: first.id });
        this.input({ kind: "send", text: first.text, images: first.images });
      });
    }
  }
  private background(n: number) {
    this.bg = n;
    this.emit({ event: "session.info", background: n });
  }
  /** The agent took the person's message `id`: its own rewind can take it back (agent_chat.rs keeps each message it took). */
  private took(id?: string) {
    this.sent++;
    this.sentIds.push(id ?? "");
  }
  private say(text: string, at: number) {
    const parts = [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))];
    this.at(at, () => this.emit({ event: "delta", text: parts[0] }));
    this.at(at + 120, () => this.emit({ event: "delta", text: parts[1] }));
    this.at(at + 240, () => this.emit({ event: "message", id: `m${++this.seq}`, text }));
  }
  input(i: ChatInput) {
    if (this.dead) throw new Error("the session has ended");
    if (i.kind === "send" && this.turn && i.id) {
      // sent while a turn runs: it waits until the agent takes it
      this.queue.push({ text: i.text, id: i.id, images: i.images });
      this.emit({ event: "message.queued", id: i.id });
      return;
    }
    if (i.kind === "steer") {
      // as the adapters do: only an agent with its own mid-turn input, only while a turn runs; it reads the message
      // into the running turn, then says it took it
      if (!steersOf(this.agent)) throw new Error(`${agentDef(this.agent).label} cannot take a message into a running answer`);
      if (!this.turn) throw new Error("nothing is running to steer");
      this.at(60, () => this.emit({ event: "message.taken", id: i.id }));
      return;
    }
    if (i.kind === "mode") {
      if (!(MOCK_MODES[this.agent] ?? []).includes(i.mode)) throw new Error(`not a mode Manut AI offers: ${i.mode}`);
      this.at(20, () => this.emit({ event: "session.info", mode: i.mode }));
      return;
    }
    if (i.kind === "effort") {
      if (!(MOCK_CONTROLS[this.agent]?.efforts ?? []).includes(i.effort)) throw new Error(`unknown effort ${i.effort}`);
      this.at(20, () => this.emit({ event: "session.info", effort: i.effort }));
      return;
    }
    if (i.kind === "send") {
      if (!this.turn) {
        this.turn = true;
        this.emit({ event: "turn.start" });
        if (this.next) {
          // the turn's init: it runs on the model picked during the last one
          this.model = this.next;
          this.next = "";
          this.emit({ event: "session.info", model: this.model, model_next: "" });
        }
      }
      if (this.how.noChat) return; // the old program reads it and says nothing
      // the lead's note in front of a message while Helpers is on (item 102e) is read as instructions, not as the command
      // and the note naming its "Kit may reach" list (item 102k)
      let text = withoutReachNote(withoutHelperPolicy(i.text)).trim();
      // a helper lane's brief (item 102h): what e2e set for helper lane n (`__manutMockHelpers`), else it does the task at once
      const brief = readHelperBrief(text);
      if (brief) text = (globalThis as { __manutMockHelpers?: Record<number, string> }).__manutMockHelpers?.[brief.n] ?? `/helperdone ${brief.n}`;
      if (text === "/exit") {
        this.at(30, () => {
          // a clean exit mid-turn, as the Rust watcher reports it (exit_turn_end)
          this.end("ended");
          this.emit({ event: "exit", code: 0, error: "" });
        });
        return;
      }
      if (text === "/quit") {
        // codex-15 (Codex 0.167): the person's own config makes Codex print a warning at start; the program then
        // closes in order (code 0). Before manut 0.2.7 the shell sent that warning as the exit's reason.
        this.at(30, () => {
          this.end("ended");
          this.dead = true;
          this.emit({ event: "exit", code: 0, error: "user (~/.codex/config.toml): `mcp_servers.playwright.type` is ignored." });
        });
        return;
      }
      if (text.startsWith("/plan")) {
        // claude-14-plan-deny.jsonl as the Claude adapter emits it: plan mode's end (ExitPlanMode) with the plan the
        // agent wrote; Claude Code offers no rule to keep for it, so Deny and Allow once only
        const rid = `req-${++this.seq}`;
        this.at(60, () => {
          this.waiting = rid;
          this.planAsk = true;
          this.emit({ event: "approval.request", request_id: rid, title: "Start working on this plan?", command: "", cwd: this.cwd, choices: ["deny", "once"], plan: MOCK_PLAN });
        });
        return;
      }
      if (text.startsWith("/kit ")) {
        // Kit's states on the Code page (src/code/): an ask as the shell writes it (agent_chat.rs), a key typed into a
        // change (`tool.diff`), each from a word; `/kit key` uses a plainly fake key; `/kit shop` a change that reads
        // the shop ID from the environment. Each is a whole turn like any other: the agent took its message, so Rewind
        // (src/sessions/rewind.ts) can take the turn back
        this.took(i.id);
        const word = text.slice(5).trim();
        if (word === "key") {
          const lines = ["@@ -1,2 +1,3 @@", " export const CURRENCY = 'THB';", '+export const PROMPTPAY_KEY = "sk-FAKE0000000000000000TEST";'];
          this.at(60, () => this.emit({ event: "tool.diff", tool_id: "t-kit", files: [{ path: "src/config.ts", kind: "update", lines, added: 1, removed: 0 }] }));
          this.say("I put the PromptPay key in src/config.ts.", 120);
          this.at(400, () => this.end("done"));
          return;
        }
        if (word === "shop") {
          // a change whose code reads the PromptPay shop ID from the environment, as the canvas's checkout needs (src/code/preview.ts)
          const lines = ["@@ -12,3 +12,4 @@", "   const total = order.items.reduce(sum, 0);", "+  const qr = promptPayQR(process.env.PROMPTPAY_SHOP_ID, total);", "   return <PayPanel amount={total} qr={qr} />;"];
          this.at(60, () => this.emit({ event: "tool.diff", tool_id: "t-kit", files: [{ path: "src/checkout.tsx", kind: "update", lines, added: 1, removed: 0 }] }));
          this.say("The QR code reads the shop ID from PROMPTPAY_SHOP_ID.", 120);
          this.at(400, () => this.end("done"));
          return;
        }
        // each names what it is as the shell does from Claude Code's own request (`tool`, src-tauri/src/ask_tool.rs)
        const cwd = this.cwd;
        const run = (line: string) => ({ title: "Run this command?", command: line, tool: { kind: "command" as const, name: "Bash", line, cwd } });
        // a lane's work as its events show it (src/code/lane.ts): a file edit, then a test run whose output comes with the
        // step's end (`tool.end`'s `output`, as the shell sends it). `pass`: 14 tests passed; `fail`: 1 of 14 failed;
        // `unread`: an output no runner printed; `slow`: the run goes on for a few seconds, so the lane is seen working.
        const runs: Record<string, { ok: boolean; output: string; say: string; ms: number }> = {
          pass: { ok: true, output: MOCK_TESTS_PASS, say: "I replaced bank transfer with a PromptPay QR. All 14 tests pass.", ms: 500 },
          slow: { ok: true, output: MOCK_TESTS_PASS, say: "The tests pass. Nothing is live.", ms: 3_000 },
          fail: { ok: false, output: MOCK_TESTS_FAIL, say: "One test fails: the QR holds 59.00 where it should hold 590.00.", ms: 500 },
          unread: { ok: true, output: "Done in 2.1s\n", say: "I ran the tests.", ms: 500 },
        };
        if (runs[word]) {
          const r = runs[word];
          const lines = ["@@ -12,3 +12,9 @@", "   const total = order.items.reduce(sum, 0);", "-  return <PayByTransfer amount={total} />;", "+  const qr = promptPayQR(SHOP_ID, total);"];
          this.at(60, () => this.emit({ event: "tool.start", tool_id: "t-edit", name: "patch", detail: "src/checkout.tsx +6 -1" }));
          this.at(80, () => this.emit({ event: "tool.diff", tool_id: "t-edit", files: [{ path: "src/checkout.tsx", kind: "update", lines, added: 6, removed: 1 }] }));
          this.at(120, () => this.emit({ event: "tool.end", tool_id: "t-edit", name: "", ok: true, ms: 60 }));
          this.at(200, () => this.emit({ event: "tool.start", tool_id: "t-test", name: "terminal", detail: "pnpm test" }));
          this.at(200 + r.ms, () => this.emit({ event: "tool.end", tool_id: "t-test", name: "", ok: r.ok, ms: r.ms, output: r.output }));
          this.say(r.say, 260 + r.ms);
          this.at(700 + r.ms, () => this.end("done"));
          return;
        }
        const asks: Record<string, { title: string; command: string; tool: AskTool }> = {
          install: run("pnpm add qrcode"),
          test: run("pnpm test"),
          merge: run("git merge main"),
          commit: run("git commit -m 'Add a PromptPay QR'"),
          deploy: run("wrangler deploy"),
          // a script run by its name: the card shows what the script runs, from the lane's package.json
          build: run("pnpm build"),
          edit: { title: "Allow Edit to change src/checkout.tsx?", command: "", tool: { kind: "edit", name: "Edit", paths: [`${cwd}/src/checkout.tsx`], cwd } },
          outside: { title: "Allow Read?", command: "/home/you/Documents/tax-2026.xlsx", tool: { kind: "read", name: "Read", paths: ["/home/you/Documents/tax-2026.xlsx"], cwd } },
        };
        const a = asks[word];
        if (!a) {
          this.say(`No such step: ${word}`, 40);
          this.at(200, () => this.end("done"));
          return;
        }
        const rid = `kit-${++this.seq}`;
        this.at(60, () => {
          this.waiting = rid;
          this.kitAsk = a.command || a.title;
          this.emit({ event: "approval.request", request_id: rid, title: a.title, command: a.command, cwd: this.cwd, choices: ["deny", "once", "session"], tool: a.tool });
        });
        return;
      }
      if (text.startsWith("/helpers")) {
        // a lead lane's answer ending with helper blocks (item 102e, src/jobs/helperBlocks.ts), streamed a few words at a time so
        // the page is seen hiding the blocks while they are written; `two` asks for two helper lanes, `mode` and `approve` write a
        // key a block never takes, `text` names the block only as an example, `many` asks for more than a round takes
        this.took(i.id);
        const word = text.slice(8).trim() || "two";
        const reply = MOCK_HELPERS[word] ?? `No such request: ${word}`;
        let at = 60;
        for (let k = 0; k < reply.length; k += 32) {
          const part = reply.slice(k, k + 32);
          this.at(at, () => this.emit({ event: "delta", text: part }));
          at += 90;
        }
        this.at(at + 60, () => this.emit({ event: "message", id: `m${++this.seq}`, text: reply }));
        this.at(at + 200, () => this.end("done"));
        return;
      }
      if (text.startsWith("/helperdone")) {
        // a helper lane that did its brief (item 102h): one step that changed a file, and a short report
        this.took(i.id);
        const n = text.slice(11).trim() || "1";
        this.at(60, () => this.emit({ event: "tool.start", tool_id: `t-h${n}`, name: "patch", detail: "src/qr.test.ts" }));
        this.at(140, () => this.emit({ event: "tool.end", tool_id: `t-h${n}`, name: "", ok: true, ms: 70 }));
        this.say(`Helper ${n}: done. I changed what the brief named and checked it with its own test.`, 220);
        this.at(600, () => this.end("done"));
        return;
      }
      if (text.startsWith("/reach")) {
        // a coding chat's answer ending with a reach block (item 102k, src/jobs/reachBlocks.ts), streamed a few words at a time so
        // the page is seen hiding the block while it is written
        this.took(i.id);
        const word = text.slice(6).trim() || "read";
        const reply = MOCK_REACH[word] ?? `No such request: ${word}`;
        let at = 60;
        for (let k = 0; k < reply.length; k += 32) {
          const part = reply.slice(k, k + 32);
          this.at(at, () => this.emit({ event: "delta", text: part }));
          at += 90;
        }
        this.at(at + 60, () => this.emit({ event: "message", id: `m${++this.seq}`, text: reply }));
        this.at(at + 200, () => this.end("done"));
        return;
      }
      if (text.startsWith("/subedit")) {
        // codex-15-sub-edit.jsonl as the Codex adapter emits it: the edit runs in a sub-agent's own thread, whose file
        // change carries its patch; the main thread edits nothing
        const sub = (extra: Record<string, unknown>) =>
          this.emit({ event: "subagent", id: "thr-sub", agent: this.agent, name: "add mul", goal: "", delegation: "codex-turn-1", index: 0, count: 1, state: "running", model: "gpt-6.1-sol", ...extra });
        const step = MOCK_SUB_EDIT.map((f) => `${f.path} +${f.added}`).join(", ");
        this.at(40, () => sub({}));
        this.at(120, () => sub({ tool: "terminal", step: "cat calc.py README.md" }));
        this.at(200, () => sub({ tool: "patch", step, diff: MOCK_SUB_EDIT }));
        this.at(260, () => sub({ tool: "patch", step, diff: MOCK_SUB_EDIT }));
        this.at(400, () => sub({ state: "done", summary: "Added mul(a, b) to calc.py and listed the functions in README.md.", seconds: 18.2 }));
        this.say("The sub-agent added mul(a, b) to calc.py and listed the functions in README.md.", 480);
        this.at(800, () => this.end("done"));
        return;
      }
      if (text.startsWith("/approve")) {
        const rid = `req-${++this.seq}`;
        this.at(60, () => this.emit({ event: "tool.start", tool_id: "t-rm", name: "terminal", detail: "rm -rf ./build" }));
        this.at(140, () => {
          this.waiting = rid;
          // an ACP agent (OpenCode) offers Deny and Allow once only: its "always" is a saved project rule
          const choices = isAcp(this.agent) ? ["deny", "once"] : ["deny", "once", "session"];
          this.emit({ event: "approval.request", request_id: rid, title: "Run this command?", command: "rm -rf ./build", cwd: this.cwd, choices });
        });
        return;
      }
      if (text.startsWith("/ask")) {
        // the shapes the adapters emit for a question (Claude Code AskUserQuestion, a Codex question) and a file edit
        const rid = `ask-${++this.seq}`;
        this.at(60, () => {
          this.waiting = rid;
          this.emit({ event: "clarify.request", request_id: rid, question: "Which greeting should go in greet.txt?", choices: ["hello", "hi"] });
        });
        return;
      }
      if (text.startsWith("/bad")) {
        this.at(60, () => this.emit({ event: "tool.start", tool_id: "t-bad", name: "terminal", detail: "definitely-not-a-command-xyz --flag" }));
        this.at(140, () => this.emit({ event: "tool.end", tool_id: "t-bad", name: "", ok: false, ms: 20 }));
        this.say("Exit code: 127.", 200);
        this.at(600, () => this.end("done"));
        return;
      }
      if (text.startsWith("/title ")) {
        // the agent names the conversation (Claude Code session_title_changed, Codex thread/name/updated)
        const name = text.slice(7).trim();
        this.at(40, () => this.emit({ event: "session.info", title: name }));
        this.say("Named it.", 80);
        this.at(400, () => this.end("done"));
        return;
      }
      if (text.startsWith("/signedout")) {
        this.at(60, () => this.end("error", `${agentDef(this.agent).label} is not signed in. Sign in from Settings › Accounts, then Restart.`));
        return;
      }
      if (text === "/die") {
        // the program dies mid-turn with nothing more on its stdout (a crash before the shell saw the turn)
        this.at(60, () => this.emit({ event: "delta", text: "partial" }));
        this.at(120, () => {
          this.stop();
          this.turn = false;
          this.emit({ event: "exit", code: null, error: "" });
        });
        return;
      }
      if (text.endsWith("/late")) {
        // OmO (omo-1-plain.jsonl): the answer, the turn's end, then a status of its own (`setStatus`) after it
        this.say("ok", 60);
        this.at(400, () => {
          this.end("done"); // clears the pending timers: the late events are scheduled after it
          this.at(50, () => this.emit({ event: "status", text: "mem:khope-sionic-ai-d09472c9 9d ago (+1)" }));
          this.at(100, () => this.emit({ event: "thinking" }));
        });
        return;
      }
      if (text.startsWith("/batch")) {
        // omo-13-batch.jsonl as the Pi adapter emits it (OmO 5.1.56): one foreground `task` with two subagents and
        // a todo list; the task result names no answer, so each row ends with what OmO's own record of that task id
        // says (answer, model, its own time), the record Plans reads too
        const d = "pi-toolu_batch";
        const sub = (i: number, extra: Record<string, unknown>) =>
          this.emit({
            event: "subagent", id: `toolu_batch:${i}`, agent: this.agent, name: i ? "helper-b-line-count" : "helper-a-first-line",
            goal: i ? "helper-b-line-count: count lines of a.txt and reply LINE_COUNT: <number>" : "helper-a-first-line: read a.txt and reply FIRST_LINE: <first line>",
            delegation: d, index: i, count: i + 1, state: "queued", ...extra,
          });
        const plan = (a: string, b: string) => this.emit({ event: "plan", items: [{ text: "Spawn foreground batch of two helper tasks", status: a }, { text: "Give one-line summary of batch results", status: b }] });
        this.at(40, () => this.emit({ event: "tool.start", tool_id: "toolu_batch", name: "delegate_task", detail: "helper-a-first-line, helper-b-line-count" }));
        this.at(50, () => sub(0, {}));
        this.at(60, () => sub(1, {}));
        this.at(70, () => plan("in_progress", "pending"));
        this.at(900, () => {
          this.emit({ event: "tool.end", tool_id: "toolu_batch", name: "", ok: true, ms: 0 });
          sub(0, { count: 2, state: "done", summary: "FIRST_LINE: alpha line", model: "claude-haiku-5-5", seconds: 19.9 });
          sub(1, { count: 2, state: "done", summary: "LINE_COUNT: 3", model: "claude-haiku-5-5", seconds: 28.6 });
          plan("completed", "completed");
        });
        this.say("Both helpers came back: `FIRST_LINE: alpha line` and `LINE_COUNT: 3`.", 1000);
        this.at(1200, () => this.end("done"));
        return;
      }
      if (text.startsWith("/subagents")) {
        // the events the Claude adapter emitted for a real run (claude-9-subagents.jsonl): two Agent calls in one
        // message, each subagent's own step, then each one's own answer and time; the second one is slow enough to
        // look at while it works. "/subagents hold" leaves the second one working until Stop or "/release".
        // (OmO's `task` names its subagents' type, `explore`; Claude Code's Agent calls are `general-purpose`)
        const kind = this.agent === "omo" ? "explore" : "general-purpose";
        const sub = (id: string, index: number, goal: string, extra: Record<string, unknown> = {}) =>
          this.emit({ event: "subagent", id, agent: this.agent, name: kind, goal, delegation: "claude-msg_1", index, count: index + 1, state: "running", ...extra });
        this.at(40, () => this.emit({ event: "tool.start", tool_id: "sa-1", name: "delegate_task", detail: "Read a.txt first line" }));
        this.at(50, () => sub("sa-1", 0, "Read a.txt first line"));
        this.at(120, () => sub("sa-1", 0, "Read a.txt first line", { tool: "read_file", step: "a.txt" }));
        this.at(160, () => this.emit({ event: "tool.start", tool_id: "sa-2", name: "delegate_task", detail: "Count lines of b.txt" }));
        this.at(170, () => sub("sa-2", 1, "Count lines of b.txt", { count: 2 }));
        this.at(260, () => sub("sa-2", 1, "Count lines of b.txt", { count: 2, tool: "read_file", step: "b.txt" }));
        this.at(600, () => {
          this.emit({ event: "tool.end", tool_id: "sa-1", name: "", ok: true, ms: 0 });
          sub("sa-1", 0, "Read a.txt first line", { count: 2, state: "done", summary: "alpha line", seconds: 3.7, model: "claude-fable-5-2" });
        });
        if (text.includes("hold")) {
          this.holding = true;
          return;
        }
        this.at(1400, () => {
          this.emit({ event: "tool.end", tool_id: "sa-2", name: "", ok: true, ms: 0 });
          sub("sa-2", 1, "Count lines of b.txt", { count: 2, state: "done", summary: "3", seconds: 9.4, model: "claude-fable-5-2" });
        });
        this.say("a.txt starts with alpha line; b.txt has 3 lines.", 1500);
        this.at(1900, () => this.end("done"));
        return;
      }
      if (text.startsWith("/subask")) {
        // claude-9-subagent-ask.jsonl: a subagent's Bash needs approval; the card names the subagent
        const rid = `req-${++this.seq}`;
        this.at(40, () => this.emit({ event: "tool.start", tool_id: "sa-3", name: "delegate_task", detail: "Write c.txt via echo" }));
        this.at(50, () => this.emit({ event: "subagent", id: "sa-3", agent: this.agent, name: "general-purpose", goal: "Write c.txt via echo", delegation: "claude-msg_2", index: 0, count: 1, state: "running" }));
        this.at(120, () => this.emit({ event: "subagent", id: "sa-3", agent: this.agent, name: "general-purpose", goal: "Write c.txt via echo", delegation: "claude-msg_2", index: 0, count: 1, state: "running", tool: "terminal", step: "echo three > c.txt" }));
        this.at(160, () => {
          this.waiting = rid;
          this.subWaiting = true;
          this.emit({ event: "approval.request", request_id: rid, title: "Run this command?", command: "echo three > c.txt", cwd: this.cwd, choices: ["deny", "once", "session"], subagent: { id: "sa-3", name: "Write c.txt via echo" } });
        });
        return;
      }
      if (text.startsWith("/lateask")) {
        // claude-13-late-ask.jsonl (Claude Code 2.1.322): the subagent runs in the background, the turn ends, and only
        // then the subagent asks; the answer reaches Claude Code with no turn running, the subagent finishes, and
        // Claude Code's own turn tells of it
        const rid = `req-${++this.seq}`;
        const sub = (extra: Record<string, unknown>) =>
          this.emit({ event: "subagent", id: "sa-4", agent: this.agent, name: "general-purpose", goal: "Write gamma to c.txt", delegation: "claude-msg_3", index: 0, count: 1, state: "running", model: "claude-opus-5-5", ...extra });
        this.at(40, () => this.emit({ event: "tool.start", tool_id: "sa-4", name: "delegate_task", detail: "Write gamma to c.txt" }));
        this.at(50, () => {
          this.bgSub = true;
          sub({ model: "claude-opus-5-5" });
        });
        this.at(60, () => this.background(1));
        this.at(80, () => this.emit({ event: "tool.end", tool_id: "sa-4", name: "", ok: true, ms: 0 }));
        this.say("started", 100);
        this.at(500, () => {
          this.end("done"); // clears the pending timers: the late ask is scheduled after it
          this.at(300, () => sub({ tool: "terminal", step: "echo gamma > c.txt" }));
          this.at(400, () => {
            this.waiting = rid;
            this.lateAsk = true;
            this.emit({ event: "approval.request", request_id: rid, title: "Run this command?", command: "echo gamma > c.txt", cwd: this.cwd, choices: ["deny", "once", "session"], subagent: { id: "sa-4", name: "Write gamma to c.txt" } });
          });
        });
        return;
      }
      if (text.startsWith("/retry")) {
        // omo-12-retry.jsonl as the Pi adapter emits it: OmO retries the failed run once by itself (the line says
        // which try), the retry fails too, and the turn ends once with OmO's own reason
        this.at(60, () => this.emit({ event: "status", text: "Retrying 1 of 5", retry: { attempt: 1, max: 5 } }));
        if (text.includes("hold")) return;
        this.at(900, () =>
          this.end("error", "Anthropic rejected this conversation's request format, even after retrying without web search replay data. Run /compact or start a new session to continue, and report it if it happens again."),
        );
        return;
      }
      if (text.startsWith("/stoplate")) {
        // codex-12-late-step.jsonl: a foreground command; Stop ends the turn at once but the command runs on, and
        // Codex reports its end after the turn (`item/completed`, 39.9 s in all)
        this.at(60, () => this.emit({ event: "tool.start", tool_id: "exec-late", name: "terminal", detail: "sleep 40; echo late" }));
        this.lateStep = "exec-late";
        return;
      }
      if (text.startsWith("/draft")) {
        // an agent's reply holding an manut-agent draft: a session chat shows no Add agent chip for it
        this.say('Here is one:\n\n```manut-agent\n{"name": "Stub ACP", "program": "stub-acp", "args": ["acp"]}\n```', 80);
        this.at(200, () => this.end("done"));
        return;
      }
      if (text.startsWith("/background")) {
        // the turn ends with a command still running in the background (Claude background_tasks_changed, OmO
        // waiting_background): the header says so until it ends. "hold": it runs on until Stop; "busy": the turn
        // itself goes on too
        this.at(40, () => this.background(1));
        this.say("started", 80);
        if (text.includes("busy")) return;
        this.at(400, () => {
          this.end("done"); // clears the pending timers: the background's end is scheduled after it
          if (!text.includes("hold")) this.at(1100, () => this.background(0));
        });
        return;
      }
      if (text.startsWith("/slow")) {
        for (let k = 0; k < 40; k++) this.at(100 + k * 250, () => this.emit({ event: "delta", text: `line ${k + 1}\n` }));
        return;
      }
      this.took(i.id);
      if (text.startsWith("/work")) {
        // the events the Claude adapter emitted for a real two-file edit (Claude Code 2.1.322, claude-12-work.jsonl):
        // thinking text, its todo list (TaskCreate, then TaskUpdate per item), an Edit per file with its change,
        // then the answer. "/work hold" stops before the last item and the answer.
        const hold = text.includes("hold");
        const plan = (s: string[]) => this.emit({ event: "plan", items: MOCK_WORK.todo.map((t, k) => ({ text: t, status: s[k] })) });
        MOCK_WORK.thinking.forEach((t, k) => this.at(30 + k * 20, () => this.emit({ event: "thinking", text: t })));
        this.at(120, () => plan(["pending", "pending", "pending"]));
        this.at(160, () => plan(["in_progress", "pending", "pending"]));
        // held: the last edit has not run yet (the list shows it under way)
        MOCK_WORK.edits.slice(0, hold ? -1 : undefined).forEach((e, k) => {
          const at = 200 + k * 160;
          this.at(at, () => this.emit({ event: "tool.start", tool_id: e.id, name: "patch", detail: e.detail }));
          this.at(at + 10, () => this.emit({ event: "tool.diff", tool_id: e.id, files: [e.file] }));
          this.at(at + 80, () => this.emit({ event: "tool.end", tool_id: e.id, name: "", ok: true, ms: 70 }));
          this.at(at + 100, () => plan(MOCK_WORK.todo.map((_, j) => (j <= k ? "completed" : j === k + 1 ? "in_progress" : "pending"))));
        });
        if (hold) return;
        this.say(MOCK_WORK.answer, 620);
        this.at(1000, () => this.end("done"));
        return;
      }
      this.at(60, () => this.emit({ event: "tool.start", tool_id: `t${this.seq}`, name: "read_file", detail: "README.md" }));
      this.at(300, () => this.emit({ event: "tool.end", tool_id: `t${this.seq}`, name: "", ok: true, ms: 240 }));
      const pics = i.images?.length ? ` (${i.images.length} picture${i.images.length > 1 ? "s" : ""})` : "";
      this.say(`(mock ${agentDef(this.agent).label}) You said: ${text}${pics}`, 360);
      this.at(800, () => this.end("done"));
    } else if (i.kind === "rewind") {
      if (!MOCK_REWINDS.includes(this.agent)) throw new Error(`${agentDef(this.agent).label} cannot take a message back here`);
      if (this.turn) throw new Error("wait until the turn ends");
      if (this.sent < 1) throw new Error("nothing to take back");
      this.sent--;
      this.sentIds.pop();
      this.at(30, () => {
        this.emit({ event: "rewound" });
        this.emit({ event: "session.info", rewind: this.sent > 0 });
      });
    } else if (i.kind === "rewind_to") {
      // agent_chat.rs `Input::RewindTo`: back to before the named message, and everything after it goes too
      if (!MOCK_REWINDS.includes(this.agent)) throw new Error(`${agentDef(this.agent).label} cannot take a message back here`);
      if (this.turn) throw new Error("wait until the turn ends");
      const at = i.id ? this.sentIds.lastIndexOf(i.id) : -1;
      if (at < 0) throw new Error(`${agentDef(this.agent).label} cannot take that message back here`);
      this.sentIds = this.sentIds.slice(0, at);
      this.sent = at;
      this.at(30, () => {
        this.emit({ event: "rewound", id: i.id });
        this.emit({ event: "session.info", rewind: this.sent > 0 });
      });
    } else if (i.kind === "interrupt") {
      if (!this.turn && this.agent === "claude" && (this.bg > 0 || this.lateAsk)) {
        // claude-13-late-ask-stop / claude-14-background-stop.jsonl: no turn runs; Claude Code withdraws the late ask,
        // stops its background subagent and command, and says nothing is left in the background
        this.stop();
        this.at(20, () => {
          if (this.lateAsk && this.waiting) this.emit({ event: "prompt.expired", request_id: this.waiting, reason: "cancelled" });
          this.lateAsk = false;
          this.waiting = null;
          if (this.bgSub) this.emit({ event: "subagent", id: "sa-4", agent: this.agent, name: "general-purpose", goal: "Write gamma to c.txt", delegation: "claude-msg_3", index: 0, count: 1, state: "cancelled", model: "claude-opus-5-5" });
          this.bgSub = false;
          this.background(0);
        });
        return;
      }
      if (!this.turn) throw new Error("nothing is running");
      this.at(20, () => {
        // as the Claude adapter does: a subagent still out when the turn stops is cancelled with it
        if (this.holding) this.emit({ event: "subagent", id: "sa-2", agent: this.agent, name: "general-purpose", goal: "Count lines of b.txt", delegation: "claude-msg_1", index: 1, count: 2, state: "cancelled" });
        this.holding = false;
        const late = this.lateStep;
        this.lateStep = "";
        this.end("interrupted");
        if (late) this.timers.push(setTimeout(() => this.emit({ event: "tool.end", tool_id: late, name: "", ok: true, ms: 39_887 }), 600));
      });
    } else if (i.kind === "approve") {
      if (i.request_id !== this.waiting) throw new Error("no such request");
      this.waiting = null;
      if (this.lateAsk) {
        // no turn runs: the subagent goes on, ends, the background count drops, and Claude Code's own turn says so
        this.lateAsk = false;
        const done = i.choice !== "deny";
        this.at(300, () => {
          this.bgSub = false;
          this.emit({ event: "subagent", id: "sa-4", agent: this.agent, name: "general-purpose", goal: "Write gamma to c.txt", delegation: "claude-msg_3", index: 0, count: 1, state: "done", summary: done ? "WROTE" : "The command was not allowed.", seconds: 7.4, model: "claude-opus-5-5" });
        });
        this.at(320, () => this.background(0));
        this.at(400, () => {
          this.turn = true;
          this.emit({ event: "turn.start" });
          this.say(done ? "The subagent finished and reported WROTE." : "The subagent could not write c.txt.", 20);
          this.at(400, () => this.end("done"));
        });
      } else if (this.planAsk) {
        // allowed: plan mode ends and the work starts; denied: the agent asks what to change
        this.planAsk = false;
        if (i.choice === "deny") this.say("What should change in the plan?", 60);
        else {
          this.at(30, () => this.emit({ event: "session.info", mode: "default" }));
          this.say("Starting on the plan.", 60);
        }
        this.at(400, () => this.end("done"));
      } else if (this.kitAsk) {
        const what = this.kitAsk;
        this.kitAsk = "";
        this.say(i.choice === "deny" ? `Okay, I did not do it: ${what}` : `Done: ${what}`, 60);
        this.at(400, () => this.end("done"));
      } else if (i.request_id.startsWith("req-") && this.subWaiting) {
        // the subagent's command ran (or was refused); the subagent hands back, then the agent answers
        this.subWaiting = false;
        const done = i.choice !== "deny";
        this.at(60, () => this.emit({ event: "tool.end", tool_id: "sa-3", name: "", ok: true, ms: 0 }));
        this.at(80, () => this.emit({ event: "subagent", id: "sa-3", agent: this.agent, name: "general-purpose", goal: "Write c.txt via echo", delegation: "claude-msg_2", index: 0, count: 1, state: "done", summary: done ? "done" : "The command was not allowed.", seconds: 4.2 }));
        this.say(done ? "ok" : "The subagent could not write c.txt.", 120);
        this.at(500, () => this.end("done"));
      } else if (i.choice === "deny") {
        this.at(40, () => this.emit({ event: "tool.end", tool_id: "t-rm", name: "", ok: false, ms: 0 }));
        this.say("Okay, I left the build folder alone.", 80);
        this.at(500, () => this.end("done"));
      } else {
        this.at(80, () => this.emit({ event: "tool.end", tool_id: "t-rm", name: "", ok: true, ms: 300 }));
        this.say(`Cleaned the build folder (${i.choice === "session" ? "allowed for this session" : "allowed once"}).`, 140);
        this.at(560, () => this.end("done"));
      }
    } else if (i.kind === "model") {
      const m = (MOCK_MODELS[this.agent] ?? []).find((x) => x.id === i.model);
      if (!m) throw new Error(`unknown model ${i.model}`);
      if (this.agent === "claude" && this.turn) {
        // Claude Code keeps the running turn on its model: the pick is for the next turn
        this.next = m.label === this.model ? "" : m.label;
        this.timers.push(setTimeout(() => this.emit({ event: "session.info", model_next: this.next }), 20));
        return;
      }
      this.model = m.label;
      this.at(20, () => this.emit({ event: "session.info", model: this.model }));
    } else if (i.kind === "clarify") {
      if (i.request_id !== this.waiting) throw new Error("no question is open");
      this.waiting = null;
      const answer = typeof i.answer === "string" ? i.answer : Object.values(i.answer).filter(Boolean).join(", ");
      this.at(40, () => this.emit({ event: "tool.start", tool_id: "t-w", name: "patch", detail: "greet.txt +1" }));
      this.at(120, () => this.emit({ event: "tool.end", tool_id: "t-w", name: "", ok: true, ms: 60 }));
      this.say(`Wrote ${answer} to greet.txt.`, 160);
      this.at(600, () => this.end("done"));
    } else {
      throw new Error("unknown input");
    }
  }
}

/** The mock's prefs files for Settings › Terminal › Import from…: an iTerm2 profile (the default first), and an Apple
 *  Terminal one beside a profile that cannot be read. */
const MOCK_IMPORT: Partial<Record<ImportApp, ImportProfile[]>> = {
  iterm2: [
    {
      name: "Harbor Night",
      default: true,
      ok: true,
      font: { name: "Menlo-Regular", size: 14 },
      colors: {
        foreground: "#d8dee9",
        background: "#14202b",
        cursor: "#f5c779",
        selection: "#2e4a62",
        ansi: ["#1c2a36", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#cfd8e3", "#4b5d6e", "#ff7a85", "#b5e08f", "#ffd68a", "#82c4ff", "#dd9cf0", "#7fd6e0", "#ffffff"],
      },
    },
    { name: "Paper", default: false, ok: true, font: { name: "NoSuchFontAnywhere-Regular", size: 12 }, colors: { foreground: "#222222", background: "#fbf8f0", cursor: "#222222", selection: "#d8d2c0", ansi: [] } },
  ],
  terminal: [
    { name: "Basic", default: true, ok: true, font: null, colors: { foreground: "#000000", background: "#ffffff", cursor: "#929292", selection: "#a4cdff", ansi: ["#000000", "#990000", "#00a600", "#999900", "#0000b2", "#b200b2", "#00a6b2", "#bfbfbf", "#666666", "#e50000", "#00d900", "#e5e500", "#0000ff", "#e500e5", "#00e5e5", "#e5e5e5"] } },
    { name: "Archived", default: false, ok: false, font: null, colors: null },
  ],
};

