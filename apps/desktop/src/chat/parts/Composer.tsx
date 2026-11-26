import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Bot, Skill } from "../../lib/protocol";
import { useStore, type OutFile, type ReplyChip } from "../../state/store";
import type { PluginRow } from "../../lib/protocol";
import { ArrowUp, CloseIcon, SourceIcon, StopIcon } from "../../ui";
import { AttachButton, Chips, chipsFor, pluginName, useDropZone, type Chip } from "./Attach";
import "./attach.css";
import { CommandPicker, SkillPicker, mirrorText } from "./Skills";
import { SIGIL, findTokens, fragmentAt, leadRow, matchSkills } from "./skillTokens";
import { THREAD_CMD, threadCommand, threadFragment } from "./threadCommand";
import { ThreadPicker } from "./ThreadPicker";
import { commandQuery, matchCommands, parseCommands, pickText, type AgentCommand } from "./commands";
import { getDraft, setDraft } from "../../app/drafts";
import { t, tx } from "../../i18n";
import { composing as imeComposing } from "../../lib/ime";
import { newer, older, onFirstLine, onLastLine, type Recall, type Step } from "./promptHistory";
import { addAt, matchMembers, mentionAt, putMention, withAction, withFolders, type Member } from "../box/context";
import { CarriedChips, FolderChips, MentionPicker } from "../box/BoxParts";
import { goes, setCarried, useCarried, withCarried, type Scope } from "../box/carry";
import { SelectionNote } from "../box/SelectionNote";
import { BringPicker, bringInto, bringRows } from "../box/Bring";
import { readRef, THREAD_DRAG, type ThreadRef } from "../box/threadContext";
import { getSessions } from "../../sessions/sessions";
import { useBoxVoice } from "../box/Voice";
import { voiceOffered } from "../../voice/engine";
import { keysCaption, sendKey, stashKey, useFollowUp, whileRunning, type BoxKind, type FollowUp } from "../box/keys";
import { filesOf, stashDraft, takeHanded } from "../../app/stash";

const MAX_H = 200;

/** Autosizing textarea with a + at its left edge for files (menu, drop on the chat, paste). Enter sends,
 * Shift+Enter breaks the line, Stop interrupts. Files go first (`chat.attach`), then
 * the text; if one fails nothing is sent and the chips stay. A "Reply there" chip sits above the text: the
 * next message points the bot at that thread (manut posts nothing). With `skills`, `$` at the start or after a
 * space opens the bot's skills, anywhere in the message, and only while one matches; a `$name` token is drawn as a
 * gray pill by a mirror layer under the textarea (same font, padding and wrapping, scrolled with it), and goes out
 * hoisted to the front as `/name` (store `send`). `/name` and `./name` go out as typed, except `./thread` at the start
 * when `onNewThread` is given: `./` opens a one-row picker for it, and a send makes a new thread of this bot with the
 * rest of the message as its first message (threadCommand.ts); the token never reaches the bot.
 * ArrowUp on the first line and ArrowDown on the last walk the person's earlier prompts of this chat (promptHistory.ts).
 * The + is Add context (item 80): files, a folder (named on its own line by its path when the message goes,
 * chat/box/context.ts), a teammate with `@` (`mentions`: typing `@` at a word's start opens the same menu) and the
 * agent's actions (`actions`: the `/` menu, which the + opens over text already typed, the action then going first).
 * With `voice` (item 81, the Mac app), the microphone and voice mode sit before Send (chat/box/Voice.tsx).
 * While an answer runs (item 95), Enter does Settings' "While an answer is running" (wait for it, or add it now) and
 * Cmd+Enter the other, for that one message (chat/box/keys.ts); a quiet line under the box says which. With no answer
 * running both keys send. Cmd+S puts the draft aside, words, folders and files, in Drafts on Home (app/stash.ts), and a
 * draft taken from there into this chat brings its files along. Notes on a selection and other chats' context (item 97,
 * chat/box/carry.ts) are chips above the text, kept by this chat's key: a send puts the ones that may go here in front of
 * the text and clears them, Cmd+S takes them along as that same text. */
export function Composer({
  bot,
  running,
  asking = false,
  offline,
  onSend,
  onSendFiles,
  onStop,
  reply,
  onClearReply,
  offlineText,
  skills: skillsOn = false,
  plugins: pluginsOn = false,
  commands,
  tools,
  action,
  foot,
  heldNote,
  onNewThread,
  history,
  onFolder,
  mentions,
  actions,
  rows = false,
  suggestion,
  onSuggestionTaken,
  voice = false,
  steers = true,
  boxKind = "member",
  limit,
  scope = {},
  waitNote = null,
}: {
  bot: Bot;
  running: boolean;
  /** An approval or question card of this bot is waiting above: the placeholder points at it. */
  asking?: boolean;
  offline: boolean;
  /** `how`: while an answer runs, whether the message waits for it or goes into it now (absent: Settings' choice). */
  onSend: (text: string, how?: FollowUp) => void;
  /** Files with the text (a bot's main chat, a SESSIONS chat agent). Without it there is no +, drop or file paste. */
  onSendFiles?: (text: string, files: OutFile[], how?: FollowUp) => Promise<void>;
  onStop: () => void;
  reply?: ReplyChip | null;
  onClearReply?: () => void;
  /** Placeholder while `offline` (default: "<bot> is offline"). */
  offlineText?: string;
  /** Offer the bot's skills on `$` (a bot's main chat). */
  skills?: boolean;
  /** List the bot's plugins in the + menu (a bot's main chat). */
  plugins?: boolean;
  /** An agent's own commands and skills, listed when the box starts with `/` (or `$`); none = no menu. */
  commands?: AgentCommand[];
  /** Controls in the row before Send (a New session chat's agent picker). */
  tools?: ReactNode;
  /** Stands in for Send (a terminal agent's Start). */
  action?: ReactNode;
  /** A quiet line under the box (a session's folder and account). */
  foot?: ReactNode;
  /** A quiet line shown while the box holds unsent text or files that the draft will not send (a New session that
   *  opens as a terminal). */
  heldNote?: string;
  /** `./thread [text]`: a new thread of this bot, `text` its first message (absent: `./thread` goes out as typed). */
  onNewThread?: (first: string) => void;
  /** The person's earlier prompts of this chat, oldest first (promptHistory.ts): ArrowUp/ArrowDown recall them. */
  history?: string[];
  /** Add context › Folder: picks a folder (null when the person cancelled); it is named in the message by its path. */
  onFolder?: () => Promise<string | null>;
  /** Add context › Mention, and `@` typed at a word's start: the teammates this chat can mention. */
  mentions?: Member[];
  /** Add context › Actions: this chat has a `/` menu (the agent's commands and skills). */
  actions?: boolean;
  /** The text field on a row of its own, with the +, the controls and Send under it, as the design canvas draws its ask
   *  box: a chat whose box carries the model and the approval level (item 80) keeps a wide field however many there are. */
  rows?: boolean;
  /** The next message the agent predicted (a coding chat with suggestions turned on, lib/suggest.ts): shown greyed in the empty box, Tab
   *  takes it and typing replaces it. It never sends anything; the box must be empty and quiet for it to show. */
  suggestion?: string | null;
  /** Tab took the suggestion into the box: the chat drops it, so clearing the box does not bring it back. */
  onSuggestionTaken?: () => void;
  /** The microphone, which puts the words heard into the text, and voice mode, which talks with the agent of this chat
   *  (item 81): a chat whose box carries the agent's controls, in the Mac app. */
  voice?: boolean;
  /** This chat's agent can take a message mid-answer (a steer). Without one, a message typed during an answer always
   *  waits, with Enter or Cmd+Enter, and the line under the box says so. */
  steers?: boolean;
  /** A team member's chat (the default) or a coding chat: what a message typed mid-answer does until the person picks (chat/box/keys.ts). */
  boxKind?: BoxKind;
  /** The account this chat runs on is at its limit (item 95, chat/box/later.ts): until when, and how to keep what is
   *  typed to send then. `onWait` is false when a message already waits in this chat. */
  limit?: { until: string; onWait: (text: string) => boolean } | null;
  /** The shop or coding account this chat belongs to (chat/box/scope.ts): a chip made under another is shown refused and
   *  never sent. */
  scope?: Scope;
  /** Why Send waits now (a lane's other chat works there, item 97): the box keeps what is typed, Send and Enter do nothing, and
   *  this line under the box says why. */
  waitNote?: string | null;
}) {
  // unsent text survives switching chats and restarts (drafts.ts; the composer is keyed by its chat)
  const [text, setText] = useState(() => getDraft(bot.name));
  useEffect(() => setDraft(bot.name, text), [bot.name, text]);
  const [chips, setChips] = useState<Chip[]>([]);
  /** Folders named for the next message (Add context › Folder), by path. */
  const [folders, setFolders] = useState<string[]>([]);
  /** Actions from the + over text already typed: the `/` menu is open for it, and a pick goes in front of the text. */
  const [forced, setForced] = useState(false);
  const [sending, setSending] = useState(false);
  /** Bring context from… is open over the box (item 97); a row dragged over the box is on it. */
  const [bringing, setBringing] = useState(false);
  const [dropOn, setDropOn] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** Cmd+S just put the draft aside: one quiet line says where it went, until the person types again. */
  const [aside, setAside] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const good = chips.filter((c) => !c.reason);
  // notes and other chats' context this chat's box carries (item 97); only the ones that may go here count as something to send
  const carried = useCarried(bot.name);
  const going = goes(carried, scope);
  const has = text.trim().length > 0 || good.length > 0 || folders.length > 0 || going.length > 0;
  /** What goes: the carried chips that may, then the text with its folders on their own lines. */
  const full = () => withCarried(folders.length ? withFolders(text, folders) : text, carried, scope);
  /** A send or Cmd+S took the chips that may go here; refused ones stay, as red files do. */
  const sentCarried = () => {
    if (going.length) setCarried(bot.name, carried.filter((c) => !going.includes(c)));
  };
  const store = useStore();
  // where an ArrowUp/ArrowDown walk through `history` stands (promptHistory.ts)
  const recall = useRef<Recall>(null);
  // leaving this chat mid-walk keeps the text typed before the walk as the draft, not the prompt on show
  useEffect(() => () => void (recall.current && setDraft(bot.name, recall.current.draft)), [bot.name]);
  /** Every text change but a recall (typing, a pick, a plugin, Edit / Ask in chat, a send) goes through here: the
   *  text is the person's own again, so the walk ends and a later ArrowUp keeps this text as the draft. */
  const edit = (next: string) => {
    recall.current = null;
    setForced(false);
    setAside(false);
    setText(next);
  };

  // the microphone's words land in the text with the caret after them; voice mode sends what was said as typed text would
  const vc = useBoxVoice({
    on: voice && voiceOffered(),
    chatKey: bot.name,
    text,
    setText: (next) => {
      placeCaret.current = next.length;
      edit(next);
    },
    running,
    asking,
    offline,
    send: (said) => onSend(said),
  });

  const listPlugins = store.pluginsList;
  const readPlugins = useCallback(() => listPlugins(bot.name), [listPlugins, bot.name]);
  /** A plugin picked in the + menu: its name goes at the start of the message, so the bot knows which to use. */
  const addPlugin = (p: PluginRow) => {
    const lead = t("att.usePlugin", { plugin: pluginName(p) });
    const next = text.startsWith(lead) ? text : lead + text;
    placeCaret.current = next.length;
    edit(next);
    ref.current?.focus();
  };

  // skills: read once, the first time the text has a `$` where a token can start, or is a single `/word` (the
  // hint below says which of the two a skill takes). The store keeps the list per bot.
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const placeCaret = useRef<number | null>(null);
  const wantSkills = skillsOn && (/(^|\s)\$/.test(text) || /^\/[\w-]*$/.test(text));
  const loadSkills = store.skills;
  useEffect(() => {
    if (!wantSkills || skills) return;
    let live = true;
    void loadSkills(bot.name).then((list) => live && setSkills(list));
    return () => {
      live = false;
    };
  }, [wantSkills, skills, loadSkills, bot.name]);
  const names = useMemo(() => (skills ?? []).map((s) => s.name), [skills]);
  const threadCmd = onNewThread ? threadCommand(text) : null;
  const tokens = useMemo(() => {
    const found = findTokens(text, names);
    return threadCmd ? [{ name: "thread", start: threadCmd.start, end: threadCmd.end }, ...found.filter((k) => k.start >= threadCmd.end)] : found;
  }, [text, names, threadCmd?.start, threadCmd?.end]); // eslint-disable-line react-hooks/exhaustive-deps
  // `./` at the start: the built-in ./thread row (no skill list needed; skills are `$name`)
  const tFrag = onNewThread ? threadFragment(text) : null;
  const [tDismissed, setTDismissed] = useState<string | null>(null);
  const threadPicking = tFrag !== null && focused && tDismissed !== text;
  const tPop = useRef<HTMLDivElement>(null);
  const pickThread = () => {
    const next = `${THREAD_CMD} `;
    placeCaret.current = next.length;
    edit(next);
    ref.current?.focus();
  };
  const frag = skills && caret !== null ? fragmentAt(text, caret) : null;
  const fragKey = frag ? `${frag.start}:${frag.query}` : null;
  const items = useMemo(() => (frag && skills ? matchSkills(skills, frag.query) : []), [skills, fragKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // a row is chosen from the start only when what is typed begins a skill's name. A name that merely contains it
  // (`$5` in `p5js`), or matches only in other letter case (`$HOME`), is listed with no row chosen: Enter sends.
  const at = active === null ? leadRow(items, frag?.query ?? "") : Math.min(active, items.length - 1);
  useEffect(() => setActive(null), [fragKey]);

  // a bot chat has no agent command list of its own: ask the bridge for what Hermes answers here, the first time
  // the box starts with `/` (a SESSIONS chat passes its own list instead, and keeps it)
  const [slash, setSlash] = useState<AgentCommand[] | null>(null);
  const wantSlashes = !commands && skillsOn && (/^\/[\w:-]*$/.test(text) || forced);
  const loadSlashes = store.slashCommands;
  useEffect(() => {
    if (!wantSlashes || slash) return;
    let live = true;
    void loadSlashes(bot.name).then((rows) => live && setSlash(parseCommands(rows)));
    return () => {
      live = false;
    };
  }, [wantSlashes, slash, loadSlashes, bot.name]);
  const menu = commands ?? (slash?.length ? slash : undefined);

  // an agent's own commands: `/` or `$` at the start of the box opens them; typing narrows the list
  const cq = menu?.length ? (forced ? { prefix: "/" as const, query: "" } : commandQuery(text)) : null;
  const cqKey = cq ? `${cq.prefix}${cq.query}` : null;
  const cmd = useMemo(() => (cq && menu ? matchCommands(menu, cq.prefix, cq.query) : null), [menu, cqKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [cmdActive, setCmdActive] = useState(0);
  const [cmdDismissed, setCmdDismissed] = useState<string | null>(null);
  const cmdOpen = !!cmd && cmd.total > 0 && focused && cqKey !== cmdDismissed;
  // no popup when no skill matches (`$20`, `$HOME` send on the first Enter); the agent's own menu wins
  const picking = !!frag && focused && fragKey !== dismissed && items.length > 0 && !cmdOpen;
  const cmdAt = cmd ? Math.min(cmdActive, Math.max(cmd.shown.length - 1, 0)) : 0;
  useEffect(() => setCmdActive(0), [cqKey]);
  const cmdPop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (cmdOpen) cmdPop.current?.querySelector(".sk-row.on")?.scrollIntoView({ block: "nearest" });
  }, [cmdOpen, cmdAt]);
  const pickCommand = (c: AgentCommand) => {
    const next = forced ? withAction(text, c) : pickText(c);
    placeCaret.current = pickText(c).length;
    edit(next);
    setCmdDismissed(`${c.prefix}${c.name} `);
  };
  /** Add context › Actions: the `/` menu, from an empty box as if `/` were typed, else over the text already there. */
  const openActions = () => {
    setCmdDismissed(null);
    if (!text.trim()) {
      placeCaret.current = 1;
      edit("/");
    } else setForced(true);
    ref.current?.focus();
  };

  // `@` at a word's start: the teammates this chat can mention, narrowed as the name is typed
  const mFrag = mentions?.length && caret !== null ? mentionAt(text, caret) : null;
  const mKey = mFrag ? `${mFrag.start}:${mFrag.query}` : null;
  const mItems = useMemo(() => (mFrag && mentions ? matchMembers(mentions, mFrag.query) : []), [mentions, mKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [mActive, setMActive] = useState(0);
  const [mDismissed, setMDismissed] = useState<string | null>(null);
  const mentioning = !!mFrag && focused && mKey !== mDismissed && mItems.length > 0 && !cmdOpen;
  const mAt = Math.min(mActive, Math.max(mItems.length - 1, 0));
  useEffect(() => setMActive(0), [mKey]);
  const pickMention = (m: Member) => {
    if (!mFrag || caret === null) return;
    const r = putMention(text, mFrag.start, caret, m);
    placeCaret.current = r.caret;
    setCaret(r.caret);
    edit(r.text);
  };
  /** Add context › Mention: an `@` at the caret, which opens the menu as typing one does. */
  const addMention = () => {
    const el = ref.current;
    const r = addAt(text, el ? el.selectionStart : text.length);
    placeCaret.current = r.caret;
    setCaret(r.caret);
    setMDismissed(null);
    edit(r.text);
    el?.focus();
  };
  /** Add context › Folder: the folder the person picks is named in the message; the same one only once. */
  const addFolder = async () => {
    if (!onFolder) return;
    setErr(null);
    try {
      const f = await onFolder();
      if (f) setFolders((cur) => (cur.includes(f) ? cur : [...cur, f]));
    } catch (e) {
      setErr(t("box.folderFailed", { error: e instanceof Error ? e.message : String(e) }));
    }
    ref.current?.focus();
  };

  /** A recalled prompt (or the draft back) fills the box, caret at the end; a picker its text would open stays shut,
   *  so the next arrow keeps walking. */
  const showRecalled = (el: HTMLTextAreaElement, step: Step) => {
    recall.current = step.recall;
    const next = step.text;
    const f = fragmentAt(next, next.length);
    setDismissed(f ? `${f.start}:${f.query}` : null);
    const q = commandQuery(next);
    setCmdDismissed(q ? `${q.prefix}${q.query}` : null);
    setTDismissed(next);
    setCaret(next.length);
    if (next === text) el.setSelectionRange(next.length, next.length);
    else {
      placeCaret.current = next.length; // the layout effect puts it there once the text renders
      setText(next);
    }
  };

  /** The mirror follows the textarea's box and scroll (its width leaves out a scrollbar). The width is the box's own,
   *  fractions kept: `clientWidth` rounds, and half a pixel less moves a line break when the row beside the field (the
   *  model's button in the box, item 85f) has a width that is not whole. */
  const syncMirror = useCallback(() => {
    const el = ref.current;
    const m = mirror.current;
    if (!el || !m) return;
    m.style.width = `${el.getBoundingClientRect().width - (el.offsetWidth - el.clientWidth)}px`;
    m.style.height = `${el.clientHeight}px`;
    m.scrollTop = el.scrollTop;
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`;
    el.style.overflowY = el.scrollHeight > MAX_H ? "auto" : "hidden";
    if (placeCaret.current !== null) {
      el.setSelectionRange(placeCaret.current, placeCaret.current);
      placeCaret.current = null;
    }
    syncMirror();
  }, [text, tokens, syncMirror]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(syncMirror);
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncMirror]);

  // the picker starts at the `/` being typed, kept inside the composer's width
  useLayoutEffect(() => {
    const p = pop.current;
    const a = anchor.current;
    const w = wrap.current;
    if (!picking || !p || !a || !w) return;
    const x = a.getBoundingClientRect().left - w.getBoundingClientRect().left - 11;
    p.style.left = `${Math.max(0, Math.min(x, w.clientWidth - p.offsetWidth))}px`;
  });
  useEffect(() => {
    if (picking) pop.current?.querySelector(".sk-row.on")?.scrollIntoView({ block: "nearest" });
  }, [picking, at]);

  const trackCaret = (el: HTMLTextAreaElement) => setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null);

  /** Put `$name ` where the `$` fragment is (the rest of its word included) and the caret after it. */
  const pick = (s: Skill) => {
    if (!frag || caret === null) return;
    let end = caret;
    while (end < text.length && !/\s/.test(text[end])) end += 1;
    const put = `${SIGIL}${s.name} `;
    const next = text.slice(0, frag.start) + put + text.slice(end).replace(/^ /, "");
    placeCaret.current = frag.start + put.length;
    setCaret(frag.start + put.length);
    edit(next);
  };

  useLayoutEffect(() => {
    ref.current?.focus();
  }, [bot.name, reply?.session_id]);

  // "Ask in chat" from the Runs drawer: the text lands here for the person to edit and send.
  const draft = store.ui.draft;
  useLayoutEffect(() => {
    if (!draft || draft.bot !== bot.name) return;
    edit(draft.text);
    // text the app put here (Edit's old message too) does not open the command menu; typing in it does
    const q = commandQuery(draft.text);
    setCmdDismissed(q ? `${q.prefix}${q.query}` : null);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(draft.text.length, draft.text.length);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.n]);

  const add = useCallback((files: File[]) => {
    setErr(null);
    setChips((cur) => [...cur, ...chipsFor(files, cur.filter((c) => !c.reason).length)]);
    ref.current?.focus();
  }, []);

  const remove = (id: string) =>
    setChips((cur) => {
      const gone = cur.find((c) => c.id === id);
      if (gone?.url) URL.revokeObjectURL(gone.url);
      return cur.filter((c) => c.id !== id);
    });

  // A draft taken from Home's Drafts into this chat (app/stash.ts): its files join the box, read back from their saved
  // copies. Its words came as the chat's draft.
  const draftN = store.ui.draft?.n;
  useEffect(() => {
    const h = takeHanded(bot.name);
    if (!h) return;
    void filesOf(h).then(({ files, missing }) => {
      if (files.length) add(files);
      if (missing.length) setErr(t("stash.missing", { names: missing.join(", ") }));
    });
  }, [bot.name, draftN, add]);

  /** Cmd+S: the draft leaves the box for Drafts on Home, with its folders and files. Nothing is sent. A file that cannot
   *  be saved keeps the whole draft in the box, with the reason. */
  const putAside = async () => {
    if (!has || sending || offline) return;
    const body = full();
    setSending(true);
    setErr(null);
    try {
      await stashDraft({ text: body, files: good, from: bot.name });
      edit("");
      setFolders([]);
      sentCarried();
      setChips((cur) => {
        cur.forEach((c) => !c.reason && c.url && URL.revokeObjectURL(c.url));
        return cur.filter((c) => c.reason);
      });
      setAside(true);
    } catch (e) {
      setErr(t("stash.failed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSending(false);
    }
  };

  // Unsent chips let go of their local copies when the composer goes; sent ones live on in the bubble.
  const latest = useRef(chips);
  latest.current = chips;
  useEffect(() => () => latest.current.forEach((c) => c.url && URL.revokeObjectURL(c.url)), []);

  const overlay = useDropZone(wrap, !offline && !!onSendFiles, add);
  /** Another chat's context as one chip above the box (item 97), from a row dropped on it or picked in Bring context from…; a
   *  refusal or a chat that could not be read is said where a file's problem is. Nothing is sent. */
  const bring = async (r: ThreadRef) => {
    setBringing(false);
    setErr(null);
    const line = await bringInto(bot.name, scope, r);
    if (line) setErr(line);
    ref.current?.focus();
  };
  const listBring = useCallback(
    (query: string) => {
      const ss = getSessions();
      return bringRows(store, { list: ss.getState().list, agents: ss.getState().agents, chatKey: ss.chatKey }, query, bot.name);
    },
    [store, bot.name],
  );
  const follow = useFollowUp(boxKind);

  /** Send with Enter or Cmd+Enter (`key`): while an answer runs they choose between waiting for it and adding it now. */
  const send = async (key: "enter" | "cmd" = "enter") => {
    if (!has || offline || sending || waitNote) return;
    const how = running ? whileRunning(key, steers, follow) : undefined;
    vc.sending();
    if (threadCmd && onNewThread) {
      if (good.length) return setErr(t("thread.cmdFiles"));
      edit("");
      onNewThread(threadCmd.first);
      return;
    }
    // the carried chips go first, then the text, then the folders named on their own lines (none: the text as typed)
    const body = full();
    if (!good.length || !onSendFiles) {
      onSend(body, how);
      edit("");
      setFolders([]);
      sentCarried();
      return;
    }
    setSending(true);
    setErr(null);
    try {
      await onSendFiles(body, good, how);
      edit("");
      setFolders([]);
      sentCarried();
      setChips((cur) => cur.filter((c) => c.reason)); // red chips stay: they were never sent
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  // one line above the box while it holds a single `/word` or `$word`. "sigil": a bot chat's `/` is a command, a
  // skill is `$name`. "none": there is no list to pick from (a bot without skills, a bridge without skills.list),
  // so the whole name goes at the start with a slash. A chat with its agent's own menu shows that instead; a bot
  // chat's `/` menu (Hermes' commands) shows instead only while it is open, so `/pl` with no command left still
  // says skills take `$`.
  const lead = commands || cmdOpen ? undefined : /^([/$])[\w-]*$/.exec(text)?.[1];
  const hint: "sigil" | "none" | null = !lead
    ? null
    : !skillsOn
      ? lead === "/" ? "none" : null
      : !skills
        ? null // the list is being read
        : !skills.length
          ? "none"
          : lead === "/" ? "sigil" : null;
  const showStop = running && !has;
  // the suggestion shows only in an empty box that is not waiting on anything else: no text, file, folder, reply or running turn
  const ghost = suggestion && !text && !has && !offline && !reply && !running && !sending ? suggestion : null;

  // the parts of the row: the +, the text field and Send (or Stop); `rows` puts the field above the others
  const attachEl = (onSendFiles || onFolder || !!mentions?.length || actions) && (
    <AttachButton
      disabled={offline || sending}
      onFiles={onSendFiles ? add : undefined}
      plugins={pluginsOn ? readPlugins : undefined}
      onPlugin={addPlugin}
      onManage={() => store.openPlugins(bot.name)}
      onFolder={onFolder ? () => void addFolder() : undefined}
      onMention={mentions?.length ? addMention : undefined}
      onActions={actions ? openActions : undefined}
      onBring={offline ? undefined : () => setBringing(true)}
    />
  );
  const fieldEl = (
    <div className="cm-field">
      <div className="cm-mirror" ref={mirror} aria-hidden="true" data-testid="composer-mirror">
        {tokens.length || picking ? mirrorText(text, tokens, picking && frag ? frag.start : null, anchor) : null}
      </div>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        disabled={offline}
        placeholder={
          offline
            ? (offlineText ?? t("cmp.offline", { bot: bot.display_name }))
            : ghost
              ? ghost
              : reply
              ? t("cmp.replyThere", { bot: bot.display_name })
              : asking
                ? t("cmp.asking")
                : t("cmp.message", { bot: bot.display_name })
        }
        aria-label={t("cmp.message", { bot: bot.display_name })}
        data-testid="composer"
        onChange={(e) => {
          vc.typed();
          edit(e.target.value);
          trackCaret(e.target);
        }}
        onSelect={(e) => trackCaret(e.currentTarget)}
        onScroll={syncMirror}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (!files.length || !onSendFiles) return;
          e.preventDefault();
          add(files);
        }}
        onKeyDown={(e) => {
          const composing = imeComposing(e);
          // Cmd+S puts the draft aside (never the browser's Save, which would save the page)
          if (stashKey(e)) {
            e.preventDefault();
            void putAside();
            return;
          }
          // Tab takes the suggestion into the box, where it is the person's own text to edit and send; nothing is sent
          if (ghost && e.key === "Tab" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !composing) {
            e.preventDefault();
            placeCaret.current = ghost.length;
            edit(ghost);
            onSuggestionTaken?.();
            return;
          }
          if (threadPicking && !composing) {
            // Enter or Tab puts `./thread ` in; Enter on a finished `./thread` sends (a new empty thread)
            if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && tFrag !== "thread")) && !e.shiftKey) {
              e.preventDefault();
              pickThread();
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setTDismissed(text);
              return;
            }
          }
          if (mentioning && !composing) {
            const n = mItems.length;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setMActive((mAt + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
              return;
            }
            if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
              e.preventDefault();
              pickMention(mItems[mAt]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setMDismissed(mKey);
              return;
            }
          }
          if (cmdOpen && cmd && !composing) {
            const n = cmd.shown.length;
            if ((e.key === "ArrowDown" || e.key === "ArrowUp") && n) {
              e.preventDefault();
              setCmdActive((cmdAt + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
              return;
            }
            if (e.key === "Tab" && n) {
              e.preventDefault();
              pickCommand(cmd.shown[cmdAt]);
              return;
            }
            // Enter takes the highlighted command unless the text already names it exactly, or (a bot chat, whose
            // menu lists Hermes' commands only) names one of the bot's skills the Hermes way: then it is sent
            const named = text === `${cmd.shown[cmdAt].prefix}${cmd.shown[cmdAt].name}` || (!commands && names.includes(text.slice(1)));
            if (e.key === "Enter" && !e.shiftKey && n && !named) {
              e.preventDefault();
              pickCommand(cmd.shown[cmdAt]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setCmdDismissed(cqKey);
              setForced(false);
              return;
            }
          }
          if (picking && !composing) {
            const n = items.length;
            if ((e.key === "ArrowDown" || e.key === "ArrowUp") && n) {
              e.preventDefault();
              setActive(e.key === "ArrowDown" ? (at + 1) % n : at <= 0 ? n - 1 : at - 1);
              return;
            }
            // with no row chosen Enter is not for the list (it sends); Tab still completes to the first row
            const row = at >= 0 ? at : e.key === "Tab" ? 0 : -1;
            if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && row >= 0 && items[row]) {
              e.preventDefault();
              pick(items[row]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault(); // the picker takes Esc, not the running answer
              setDismissed(fragKey);
              return;
            }
          }
          // shell-like history: an arrow with no line left to move to recalls the person's earlier prompts;
          // Alt+arrow recalls from any line, so a multi-line draft need not be walked to its edge first
          const plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
          const alt = e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey;
          if ((e.key === "ArrowUp" || e.key === "ArrowDown") && (plain || alt) && history?.length && !composing && !threadPicking && !cmdOpen && !picking) {
            const el = e.currentTarget;
            const step =
              e.key === "ArrowUp"
                ? alt || onFirstLine(text, el.selectionStart) ? older(history, recall.current, text) : null
                : alt || onLastLine(text, el.selectionEnd) ? newer(history, recall.current) : null;
            if (step) {
              e.preventDefault();
              showRecalled(el, step);
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey && !composing) {
            e.preventDefault();
            // Cmd+Enter does the other of wait and add now while an answer runs; any other Enter is a plain send
            void send(sendKey(e) ?? "enter");
          } else if (e.key === "Backspace" && !text && reply) {
            e.preventDefault();
            onClearReply?.();
          }
        }}
      />
    </div>
  );
  const buttonEl = action ? (
    action
  ) : showStop ? (
    <button type="button" className="send stop" aria-label={t("cmp.stop")} title={t("cmp.stop")} onClick={onStop} data-testid="stop">
      <StopIcon />
    </button>
  ) : (
    <button
      type="button"
      className="send"
      aria-label={t("cmp.send")}
      title={t("cmp.send")}
      disabled={!has || offline || sending || !!waitNote}
      onClick={() => void send()}
      data-testid="send"
    >
      <ArrowUp />
    </button>
  );

  return (
    <div
      className="cw"
      ref={wrap}
      // Esc stops the microphone or voice mode before it stops a running answer (app/shortcuts.ts skips a key taken here)
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented && !imeComposing(e) && vc.escape()) e.preventDefault();
      }}
    >
      {overlay}
      <SelectionNote chatKey={bot.name} scope={scope} box={wrap} onDone={() => ref.current?.focus()} />
      {threadPicking && <ThreadPicker bot={bot.display_name} active onPick={pickThread} popRef={tPop} />}
      {picking && <SkillPicker items={items} active={at} onPick={pick} onHover={setActive} popRef={pop} />}
      {cmdOpen && cmd && <CommandPicker items={cmd.shown} more={cmd.total - cmd.shown.length} active={cmdAt} onPick={pickCommand} onHover={setCmdActive} popRef={cmdPop} />}
      {bringing && <BringPicker rows={listBring} onPick={(r) => void bring(r)} onClose={() => (setBringing(false), ref.current?.focus())} />}
      {mentioning && <MentionPicker items={mItems} active={mAt} onPick={pickMention} onHover={setMActive} />}
      {hint && (
        <div className="hint" role="note" data-testid="skill-hint" data-kind={hint}>
          <span className="hint-k">{hint === "sigil" ? "$skill" : "/skill"}</span>{" "}
          {hint === "sigil"
            ? tx("cmp.skillSigil", { example: <code>$plan</code>, bot: bot.display_name })
            : tx("cmp.skillHint", { example: <code>/plan</code>, bot: bot.display_name })}
        </div>
      )}
      {vc.above}
      <div
        className={`composer${has ? " has" : ""}${rows ? " bx-rows" : ""}${dropOn ? " drop-ctx" : ""}`}
        data-testid="composer-box"
        // a side-menu, History or lane row dragged onto the box brings that chat's context (item 97)
        onDragOver={(e) => {
          if (offline || ![...e.dataTransfer.types].includes(THREAD_DRAG)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDropOn(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn(false);
        }}
        onDrop={(e) => {
          const r = readRef(e.dataTransfer.getData(THREAD_DRAG));
          setDropOn(false);
          if (!r) return;
          e.preventDefault();
          void bring(r);
        }}
      >
        {dropOn && (
          <div className="bx-drop-ctx" aria-hidden="true">
            {t("carry.drop")}
          </div>
        )}
        <Chips chips={chips} onRemove={remove} />
        <FolderChips folders={folders} onRemove={(f) => setFolders((cur) => cur.filter((x) => x !== f))} />
        <CarriedChips chatKey={bot.name} list={carried} scope={scope} onRemoved={() => ref.current?.focus()} />
        {err && (
          <div className="att-err" role="alert" data-testid="attach-error">
            {err}
          </div>
        )}
        {reply && (
          <span className="reply-chip" data-testid="reply-chip" data-session={reply.session_id}>
            <SourceIcon source={reply.source} size={12} />
            <span className="rc-t">
              {reply.place} <span className="rc-k">· {reply.kind}</span>
            </span>
            <button
              type="button"
              className="rc-x"
              aria-label={t("cmp.removeReply")}
              title={t("cmp.remove")}
              onClick={() => {
                onClearReply?.();
                ref.current?.focus();
              }}
              data-testid="reply-chip-remove"
            >
              <CloseIcon />
            </button>
          </span>
        )}
        {rows ? (
          <>
            {fieldEl}
            <div className="composer-row bx-row">
              {attachEl}
              <span className="bx-gap" />
              {tools}
              {vc.buttons}
              {buttonEl}
            </div>
          </>
        ) : (
          <div className="composer-row">
            {attachEl}
            {fieldEl}
            {tools}
            {vc.buttons}
            {buttonEl}
          </div>
        )}
      </div>
      {ghost && (
        <div className="cmp-sugg" role="note" data-testid="suggest-hint">
          {t("suggest.hint")}
        </div>
      )}
      {heldNote && has && (
        <div className="cmp-held" role="note" data-testid="composer-held">
          {heldNote}
        </div>
      )}
      {/* The account is at its limit: Enter still sends now, and one button keeps the words to send at the reset. A
          message with files cannot wait (its copies are the session's), so the line only says when the limit lifts. */}
      {limit && has && !running && !offline && !action && (
        <div className="cmp-keys cmp-later" role="note" data-testid="composer-limit">
          <span>{t(good.length ? "later.limitFiles" : "later.limit", { when: limit.until })}</span>
          {!good.length && (
            <button
              type="button"
              className="card-btn"
              onClick={() => {
                if (!limit.onWait(full())) return;
                edit("");
                setFolders([]);
                sentCarried();
              }}
              data-testid="composer-wait"
            >
              {t("later.sendAt", { when: limit.until })}
            </button>
          )}
        </div>
      )}
      {waitNote && (
        <div className="cmp-keys" role="note" data-testid="composer-lane-wait">
          {waitNote}
        </div>
      )}
      {aside && (
        <div className="cmp-keys" role="status" data-testid="composer-stashed">
          {t("stash.put")}
        </div>
      )}
      {/* While an answer runs, what Enter does with what is typed, and what Cmd+Enter does instead (item 95). */}
      {running && has && !action && !offline && (
        <div className="cmp-keys" role="note" data-testid="composer-keys" data-steers={steers ? "true" : "false"}>
          {keysCaption(steers, bot.display_name, follow)}
        </div>
      )}
      {foot}
    </div>
  );
}
