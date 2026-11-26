// The app view model's types: a chat and its timeline rows, the UI's own state, the whole AppState, and the few
// fixed lists that name their values (bubble styles, palettes, the menu's pages). Split out of store.ts (item 125d),
// which re-exports every name here, so a UI node still imports the view model from the store alone.
import type { BridgeStatus } from "../lib/bridge";
import type { Lang } from "../i18n";
import type { FlowState } from "../onboarding/flow";
import type { ShopProfile } from "../onboarding/shop";
import type {
  Away,
  ApprovalChoice,
  Bot,
  ClarifyAnswers,
  ClarifyQuestion,
  HelloResult,
  ModelOptions,
  AgentBox,
  PeekMsg,
  Routine,
  SubagentState,
  AskSubagent,
  AskTool,
  AttachKind,
  Automation,
  DiffFile,
  PlanItem,
  AskShop,
  PassedOnNote,
  ShopLeft,
  ShopRow,
} from "../lib/protocol";
import type { ThreadRow } from "../threads/types";
import type { HelpersAsk } from "../jobs/helperAsks";

export type PanelTabId = "details" | "terminal" | "schedule" | "worktrees" | "diff" | "runs";

// ---- view model types -----------------------------------------------------------------------

export interface Step {
  id: string;
  name: string;
  detail: string;
  startedAt: number; // ms
  endedAt?: number; // ms
  ok?: boolean;
  /** Still running when the person pressed Stop (`ok` false, `endedAt` the Stop). */
  stopped?: boolean;
  /** A stopped step the agent later said it finished (Codex runs a command on after Stop): how it ended and when. */
  late?: { ok: boolean; endedAt: number; ms: number };
  /** delegate_task: the dag parts this call handed out (one plain line each in the activity details). */
  dag?: { run: string; node: string }[];
  /** A file edit's change, per file (SESSIONS agents), for the step's diff view. */
  diff?: DiffFile[];
  /** Read back from a record with no later timestamp (a child's session): its length is unknown, none is shown. */
  untimed?: boolean;
}

export interface Turn {
  id: string;
  startedAt: number; // ms
  endedAt?: number; // ms
  outcome?: "done" | "interrupted" | "ended" | "error";
  error?: string;
  /** Latest tool text ("Reading gateway.log") or status text. */
  status: string;
  steps: Step[];
  skills: string[];
  /** Answer text streamed so far (cleared when the final `message` lands). */
  streaming: string;
  /** Where in `streaming` the text after the latest tool call starts: what came before was the bot's commentary
   *  beside that call ("Now I'll run the tests"), never part of the answer, so it is never shown. */
  cut?: number;
  /** The first message the person sent while this turn's answer was already showing: the answer stays above it
   *  (it was read under the answer being written, and is answered next). A message sent before any of the answer
   *  showed is folded into this turn by Hermes (steer), so the answer lands after it as usual. */
  before?: string;
  /** The fan-outs (delegate_task children) this turn started, as Hermes' subagent events tell them. */
  fanouts?: Fanout[];
  /** The agent's own todo list as it last stood in this turn (SESSIONS agents). */
  plan?: PlanItem[];
  /** What the agent thought, when it sends the text (SESSIONS agents); at most THINKING_MAX characters. */
  thinking?: string;
  /** The words written between the last tool call and a `clarify` ask: the question's context, which the cut below
   *  would otherwise drop. Held until the ask arrives, then kept as its own row above the card. */
  askNote?: string;
  /** A lead lane's turn that started with Helpers on in its box (item 102e, src/jobs/): its helper blocks are the app's to read, so
   *  the chat hides them while the answer streams and takes them out of the answer it keeps (`shownText`). */
  helpers?: true;
}

/** One subagent of a fan-out, as its latest event left it. */
export interface SubagentRow {
  id: string;
  index: number;
  goal: string;
  /** Which agent reported it (a session's CLI) and its name or type, when the agent gives them. */
  agent?: string;
  name?: string;
  /** Its recent steps, oldest first (at most SUB_STEPS): what the row shows when opened. A file edit carries its
   *  change per file. */
  steps?: { tool?: string; text: string; diff?: DiffFile[] }[];
  model?: string;
  dag?: { run: string; node: string };
  state: SubagentState;
  tool?: string;
  step?: string;
  summary?: string;
  /** Its own run time when it ended (Hermes'), else counted from `startedAt`. */
  seconds?: number;
  startedAt: number; // ms
  endedAt?: number; // ms
}

/** One fan-out of a turn: the children of one delegate_task call. */
export interface Fanout {
  /** The delegation id once Hermes names it; until then a local key. */
  key: string;
  delegation?: string;
  count: number;
  startedAt: number; // ms
  /** When its last event came (ms): a fan-out no event moved for a while is not shown as running. */
  updatedAt: number;
  subs: SubagentRow[];
}

/** Timeline items. `ts` is seconds since epoch so chat rows and away lines sort together. */
export type MessageItem = {
  kind: "user" | "assistant";
  id: string;
  ts: number;
  text: string;
  /** assistant rows only: the answer to an automation's delivered result, drawn under a "Watch · <name>" line. */
  watch?: { name: string; ts: number };
  /** user rows only: the send failed (text of the bridge error). */
  error?: string;
  /** user rows only: sent while a turn ran, and the agent has not taken it yet (`queued`), or Stop threw it away
   *  before the agent read it (`dropped`). */
  wait?: "queued" | "dropped";
  /** user rows only (a bot's main chat): typed while a turn ran, so manut holds it and sends it when the turn ends
   *  (steer queue). Not sent to Hermes yet: it can still be sent now, steered in, edited or deleted. */
  held?: boolean;
  /** user rows only, with `held`: typed while a turn runs and being steered into it (messenger style: the bot keeps
   *  working and takes it in). It reads as a plain sent message; a refused or unanswered steer drops this and the
   *  row waits with its ↵ ↓ × buttons, sent after the turn. */
  autoSteer?: boolean;
  /** user rows only: steered into the running turn (Hermes' `session.steer`) instead of sent as a new turn. */
  steered?: boolean;
  /** user rows only: the bot has it (chat.send went through, its turn started, or Hermes queued the steer), at this
   *  time (ms); 0 when the time is not known. Messenger-style "Read" under the person's last message. A send that
   *  failed, a refused or uncertain steer, or one the turn dropped unread never carries it. */
  readAt?: number;
  /** user rows only, with `steered`: the first line the bot wrote after reading it (the note before its next tool
   *  call, or the answer), so the person sees how it took the steer. */
  steerReply?: string;
  /** user rows only (held): a steer whose answer never came back (the bridge dropped, the bot went offline, a
   *  timeout). Hermes may have taken it, so it is never sent again on its own: the person picks Send or Delete. */
  steerUnknown?: boolean;
  /** user rows only, with `steerUnknown`: steered in, then Stop or Send now ended the turn before it read the text
   *  (Hermes drops an unread steer then): not used, it waits for Send or Delete. */
  steerUnused?: boolean;
  /** user rows only: sent with "Reply there" (where the person pointed the bot). */
  reply?: { source: string; label: string };
  /** user rows only: files sent with it, shown from the local copies (never read back). */
  files?: SentFile[];
  /** user rows only: the prompt text actually sent when it differs from `text` (files add `@file:` refs). */
  sent?: string;
  /** user rows only: the skills its `$name` tokens called, drawn as pills in the bubble. */
  skills?: string[];
};

/** A file the person sent, as their own bubble shows it. `url` is a blob URL for pictures and video. */
export interface SentFile {
  name: string;
  size: number;
  kind: "image" | "video" | "file";
  url: string | null;
}

/** One file to send: the Hermes attach call it takes, its bytes, and how the bubble shows it. */
export interface OutFile extends SentFile {
  attach: AttachKind;
  read: () => Promise<string>;
}
export type ActivityItem = { kind: "activity"; id: string; ts: number; turn: Turn };
/** Why an ask stopped waiting without an answer from manut: the gateway timed it out, withdrew it, or it was
 *  answered somewhere else (another Hermes window, Slack). */
export type AskExpiry = "timeout" | "cancelled" | "resolved";
export type ApprovalItem = {
  kind: "approval";
  id: string;
  ts: number;
  request_id: string;
  title: string;
  command: string;
  /** `command` is read whole before it is approved (a browser write's sentence): shown with nothing cut or scrolled away. */
  whole?: boolean;
  choices: ApprovalChoice[];
  /** The folder the command runs in, when the agent says. */
  cwd?: string;
  /** The plan the agent asks to start on (plan mode), as markdown. */
  plan?: string;
  /** What the agent asked to do, as the shell read it from the agent's own message, for Kit's dial (src/code/ask.ts).
   *  Never shown: its command line can hold a key. */
  tool?: AskTool;
  /** Asked inside a subagent: which one. */
  subagent?: AskSubagent;
  /** Asked while no turn ran in a coding-agent session (a background subagent after the turn's end): no turn's end
   *  closes it. */
  outside?: boolean;
  /** This app cannot answer it (a kind or a state this version does not know): no answer is offered, and the card says
   *  to update the app. */
  outdated?: boolean;
  resolved?: ApprovalChoice;
  /** Who settled it, when it was not the person at this Mac: a paired phone's device id (src/remote/serve.ts). */
  decidedBy?: string;
  expired?: AskExpiry;
  /** Why it stopped waiting, in words, when the runtime said more than the reason ("Already decided by Mint at 19:42"). */
  expiredNote?: string;
  /** The shop it comes from, when the runtime shows several (docs/several-shops.md): the card names it, and what it
   *  offers follows the person's role there. */
  shop?: AskShop;
  /** The person may not decide it at that shop but may pass it on to the owner with a note (`approval.pass_on`). */
  passOn?: boolean;
  /** A note a helper passed on with it. */
  passedOn?: PassedOnNote;
  /** approval-core's kind, for an ask of one of several shops: what the card says only the owner may decide. */
  approvalKind?: string;
};
export type ClarifyItem = {
  kind: "clarify";
  id: string;
  ts: number;
  request_id: string;
  question: string;
  choices?: string[];
  /** Several picks allowed (single question). */
  multi?: boolean;
  /** An interview: every question of the ask (2-5), answered in one card. */
  questions?: ClarifyQuestion[];
  subagent?: AskSubagent;
  outside?: boolean;
  answer?: string;
  /** Interview answers per question id (null = skipped). */
  answers?: ClarifyAnswers;
  expired?: AskExpiry;
};
export type RoutineItem = {
  kind: "routine";
  id: string;
  ts: number;
  routine_id: string;
  name: string;
  status: string;
  /** Failed runs of this routine folded into this one line, back to back with nothing between them (1 = this run). */
  count?: number;
  /** The first of those runs (`ts` is the latest). */
  since?: number;
};
/** A card for an automation the bot made from this chat (`routine.added`): what, when, where it delivers. */
export type RoutineAddedItem = {
  kind: "routineAdded";
  id: string;
  ts: number;
  routine_id: string;
  name: string;
  schedule: string;
  next_run_at: number | string | null;
  deliver: string;
  origin: { platform: string; place: string } | null;
};
/** A card for a plugin the bot installed from this chat (`plugin.added`). */
export type PluginAddedItem = { kind: "pluginAdded"; id: string; ts: number; name: string; title: string; tools: number; hooks: number };
/** manut set up its Slack briefing for this bot: one gray line, once per bot, with Turn off (the job's pause). */
export type BriefNoticeItem = { kind: "briefNotice"; id: string; ts: number; bot: string };
/** One quiet line from manut itself (e.g. "Switched to Claude #2 (limit on #1)"); never sent to the bot. */
export type SystemItem = { kind: "system"; id: string; ts: number; text: string };
/** "→ thread: <title>" under a main-chat answer: the bot opened `thread` (or the person sent a message there). */
export type ThreadLinkItem = { kind: "threadLink"; id: string; ts: number; bot: string; thread: string; title: string };
/** "Send this to <title>?" under a main-chat answer whose bot thought the person's message belongs in `thread`.
 *  `text` is that message; nothing is sent until Send there. `done`: what the person chose. */
export type ThreadRouteItem = {
  kind: "threadRoute";
  id: string;
  ts: number;
  bot: string;
  thread: string;
  title: string;
  text: string;
  done?: "sent" | "kept";
  error?: string;
};
/** A lead lane's Start helpers card (item 102e, src/jobs/HelpersCard.tsx): the round of helper lanes its agent asked for, one
 *  approval settled once through approval-core (src/jobs/helperAsks.ts). `done`: what became of it here, for the line it collapses
 *  to. Never saved: after a restart the card is gone and nothing of it starts. */
export type HelpersAskItem = {
  kind: "helpersAsk";
  id: string;
  ts: number;
  ask: HelpersAsk;
  done?: "started" | "notNow" | "gone";
};
export type ChatItem =
  | MessageItem
  | ActivityItem
  | ApprovalItem
  | ClarifyItem
  | RoutineItem
  | RoutineAddedItem
  | PluginAddedItem
  | SystemItem
  | BriefNoticeItem
  | ThreadLinkItem
  | ThreadRouteItem
  | HelpersAskItem;
export type TimelineItem = ChatItem;

export interface Chat {
  /** user / assistant / activity / approval / clarify / routine rows in arrival order. */
  items: ChatItem[];
  /** The user/assistant subset of `items`, as plain messages. */
  messages: { id: string; role: "user" | "assistant"; text: string; ts: number }[];
  turn: Turn | null;
  lastTurn: Turn | null;
  model: string;
  provider: string;
  reasoning: string;
  loaded: boolean;
  sessionId: string | null;
  turnSeq: number;
  /** Set when chat.open failed (bot offline, gateway refused); the timeline shows it instead of loading forever. */
  openError?: string | null;
  /** A status that came while no turn ran (Hermes says "Resuming interrupted turn…" just before the turn starts):
   *  never shown on its own; a turn that starts within EARLY_STATUS_MS opens with it. */
  early?: { text: string; at: number } | null;
  /** Steer queue (a bot's main chat): the held user rows' ids in the order they go out (head first). */
  queue?: string[];
  /** The id of a held message just sent whose turn has not started yet: nothing else goes out until it does. */
  pendingTurn?: string | null;
  /** The bridge dropped: the chat is re-read (chat.open) before anything held goes out. */
  stale?: boolean;
  /** The held row being steered right now: nothing goes out until Hermes answers. */
  steering?: string | null;
  /** Rows steered into the running turn that it has not read yet (no tool step ended and no message came since):
   *  a Stop or Send now before then makes Hermes drop them, so they are marked not used (Send / Delete). */
  steeredUnread?: string[];
  /** The last steered row the turn consumed, waiting for the bot's first words after it: they start at `from` in the
   *  turn's `streaming` and end at its next tool call (or are the answer). */
  steerAck?: { id: string; from: number } | null;
}

/** The composer's "Reply there" chip: a thread elsewhere the next message points the bot at. */
export interface ReplyChip {
  session_id: string;
  source: string;
  /** "#og-dev" (or the source name when the place is unknown). */
  place: string;
  kind: "thread" | "channel";
}

export interface Peek {
  messages: PeekMsg[];
  total: number;
  loading: boolean;
  error?: string;
}

export type Theme = "system" | "dark" | "light";
/** The colour set: the brand's, for everyone (item 85i: "no accent for the person to pick"). A look saved with one of the
 *  five sets the app once offered (graphite, ocean, forest, sunset, rose) is read, found not to be one, and read as this. */
export type Palette = "manut";
/** soft = both sides in tinted bubbles; solid = your bubble in the accent colour; open = the bot writes on the page
 *  and only your messages are bubbles (the default since item 85f: the Chat board's look). */
export type BubbleStyle = "soft" | "solid" | "open";
export const BUBBLE_STYLES: BubbleStyle[] = ["soft", "solid", "open"];
export type TextSize = "small" | "medium" | "large";
export interface Look {
  palette: Palette;
  bubbles: BubbleStyle;
  text: TextSize;
}
export const PALETTES: Palette[] = ["manut"];

/** The pages of the side menu (src/sidebar/menu.ts) that fill the main column, in the menu's order: Home, which the New
 *  row and the brand mark open and where the app starts, then each row's own page. They are places of their own, like
 *  the chat: a page opened from one of them (Settings, Automations, Plugins, Tasks) returns to it. */
export const MENU_PAGES = ["home", "needs", "team", "code", "artifacts", "customize", "history"] as const;
export type MenuPage = (typeof MENU_PAGES)[number];
export const isMenuPage = (view: string): view is MenuPage => (MENU_PAGES as readonly string[]).includes(view);

export interface Ui {
  panelOpen: boolean;
  panelTab: PanelTabId;
  /** The run the Runs tab shows (a full id, or a dag run name from a chat line); null = the first in its list. */
  runId: string | null;
  /** The side panel is maximised in place: it takes every pixel right of the sidebar and the chat column folds to 0
   *  (still mounted). Closing the panel restores it. */
  panelMax: boolean;
  /** Text put into a bot's composer for the person to edit and send (never sent by manut). */
  draft: { bot: string; text: string; n: number } | null;
  theme: Theme;
  look: Look;
  /** "session" = a terminal session (listed on the Code page) fills the main column; `session` names it.
   *  "automations" and "plugins" are entries of the Customize page; "job" is one job's page (`job` names it) and
   *  "activity" the shop's activity log, both opened from History, Home or a member's page and returning to where they
   *  were opened from; the menu's own pages are `MenuPage`. */
  view: "chat" | "settings" | "session" | "automations" | "plugins" | "tasks" | "job" | "activity" | MenuPage;
  /** Where a page's back arrow (and Settings' ×) returns: the chat, the session or the menu page it was opened from. */
  back: "chat" | "session" | MenuPage;
  /** Bumped by the command palette's "Search History for ..." row: the History page's search box takes the focus on each new value. */
  findSeq: number;
  /** The words the last such press carried; History puts them in its box when it takes the focus. */
  findQuery: string;
  /** Automations: the job the detail panel shows (`<bot>:<id>`); Plugins: the bot whose plugins the page shows. */
  automation: string | null;
  /** The job view: the job it shows (a `jobs.list` id). */
  job: string | null;
  pluginsBot: string | null;
  /** The UI language (Settings › General › Language), saved as `manut.lang`. */
  lang: Lang;
  settingsPage: string;
  /** Sidebar: bots pinned to the top (in pin order). Saved on this computer. */
  pinned: string[];
  /** The roster: the bots the sidebar lists, in the order they joined (`manut.roster`). null until the first run of
   *  this build has chosen it (seedRoster). Others join from Settings › All bots. */
  roster: string[] | null;
  /** The ask card to scroll to and focus (set by the Needs-you strip and ⌘J); `seq` re-triggers the same one. */
  focusAsk: FocusAsk | null;
  session: string | null;
  /** The thread under `selectedBot` the main column shows (`view` "chat"); null = the bot's main chat. */
  thread: string | null;
  /** The person and their shop as the first-run setup took them, kept on this computer as `manut.shop`
   *  (src/onboarding/shop.ts). The account row at the bottom of the menu names them, and Home names the shop. */
  shop: ShopProfile;
  /** The first-run setup while it fills the window (src/onboarding), or null. `view` stays where the app will be when
   *  the setup ends, which is Home. */
  firstRun: FlowState | null;
}

export interface FocusAsk {
  bot: string;
  id: string;
  seq: number;
}

/** The person's shops, as the runtime lists them for the switcher in the account row (`shops.list`). */
export interface ShopsState {
  /** the ones they own first; empty on a runtime that shows no shops, and the switcher shows only with two or more */
  list: ShopRow[];
  /** the shop every page shows */
  current: string | null;
  /** shops the person's place in ended while the app ran, newest first */
  left: ShopLeft[];
  /** the ids of `left` the person dismissed */
  dismissed: string[];
  /** whether the list was read once: a change of `current` after that is a switch, and the pages are read again */
  loaded: boolean;
}

export interface AppState {
  conn: BridgeStatus;
  hello: HelloResult | null;
  lastError: string | null;
  bots: Bot[];
  selectedBot: string | null;
  chats: Record<string, Chat>;
  unread: Record<string, number>;
  elsewhere: Record<string, Away[]>;
  peeks: Record<string, Peek>;
  routines: Record<string, Routine[]>;
  /** Every bot's automations (`automations.list`, read from each profile's cron/jobs.json); null until read. */
  automations: Automation[] | null;
  models: Record<string, ModelOptions>;
  /** Per chat (a bot's main chat by its name, a thread by its `fold:` key): the chat box's own choices when the chat
   *  answers through the person's coding agent (`agent.box`, Buddy in Practice), null when it does not; absent until
   *  read. */
  agentBox: Record<string, AgentBox | null>;
  /** Per bot: the composer's "Reply there" chip, if any. */
  replyTo: Record<string, ReplyChip | null>;
  /** Per bot: its threads (bridge `thread.list`), newest first; absent until read. */
  threads: Record<string, ThreadRow[]>;
  shops: ShopsState;
  ui: Ui;
}
