// The terminals of the sessions store (lifted out of sessions.ts, the refactor of 27 Nov 2026): each session's xterm, made when
// its view first shows and kept across views, the program started in it (a CLI, or the person's login shell after it), its size
// told to the program once it settles, the bell and the notification escapes read as a ring, a Codex row's conversation id asked
// for until it is known, the kept history shown dimmed after a restart, and files dropped on it typed as paths.
//
// `createTerminals` takes what it reads from the store as `TerminalsDeps`. Maps the store also reads (the terminals by session,
// their history keeping, the rows to start again) are the store's and handed in; anything the store defines later or changes
// (its state, its close, its notifier) is read through a function, so it is always the current one.
import type { ITerminalInitOnlyOptions, ITerminalOptions, Terminal } from "@xterm/xterm";
import { afterOpen, bracketedPaste, CELLS_EVENT, feed, gpuComing, isParked, live, onVisible, PARKING_EVENT, programEnded } from "./term/engine";
import { TERM_INPUT_EVENT } from "./term/paste-guard";
import { onCwd, onProgress } from "./term/engine-marks";
import { setTermFolder } from "./term/engine-paths";
import { applyLook, termOptions } from "./term/look";
import { termFontsReady } from "./term/fonts";
import { onTermSettings, readTermSettings } from "./term/settings";
import { restoredText, trackHistory } from "./term/history";
import { termTheme } from "./term/themes";
import { getShellHost, learnThisHost } from "../terminal/host";
import { onSessionFg } from "./fg";
import { termActs } from "./termActivity";
import { isLinkId } from "./termLink";
import { agentDef, idInUse, isShell, LAST_LINE_MAX, refusedResume, SHELL, termEnd, termMarkAgent, lastPrintedLine, setsUpScreen, UI_BYTES, sessionMode, type SessionRec, type Unseen } from "./agents";
import type { ConvState, SessionHost } from "./host";
import { pathsTyped, shellQuote } from "./attach";
import { workDir } from "../code/laneBranch";
import { t as tr } from "../i18n";
import type { SessionNote } from "../lib/notify";
import { ranElsewhere, revealFolder as openFolderGroup, setFolderGone } from "./folders";
import { errText } from "./sessionErrors";
import { SAID_MAX, OUT_MARK_MS, RESIZE_SETTLE_MS, utf8, newConversationId, TERM_CONTINUES, CODEX_ID_FIRST_MS, CODEX_ID_EVERY_MS } from "./sessionPure";
import type { SessionsState, Term, TermIo } from "./sessionTypes";

export type Xterm = [typeof import("@xterm/xterm"), typeof import("@xterm/addon-fit")];
let xtermLoad: Promise<Xterm> | null = null;
let xtermMods: Xterm | null = null;
/** xterm (about 88 kB gz) loads when the first session opens, not with the app. */
export const loadXterm = () =>
  (xtermLoad ??= Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/xterm/css/xterm.css"), termFontsReady()]).then(
    ([x, f]) => (xtermMods = [x, f]),
  ));

export interface TerminalsDeps {
  readonly host: SessionHost;
  rec(id: string): SessionRec | undefined;
  patchRec(id: string, patch: Partial<SessionRec>): void;
  /** The agents this computer offers, as the store last read them. */
  agents(): SessionsState["agents"];
  accountOf(r: SessionRec): string | undefined;
  nameOf(r: SessionRec): string;
  /** Marks session `id`'s row; true when that is new (a notification then goes out). */
  flag(id: string, what: Unseen): boolean;
  /** The notifier of a session's state, as the app last set it. */
  notifyState(): ((id: string, n: SessionNote) => void) | null;
  tellEnd(id: string, kind: "ended" | "failed", detail: { code?: number | null; error?: string }): void;
  setSessionFg(id: string, agent: string | null): void;
  /** The shell has been reset once this run: a program starts only after it. */
  ready(): Promise<unknown>;
  close(id: string): void;
  /** A row closed and waiting to be undone whose program ended: its close goes ahead now. */
  graceFinish(id: string): void;
  /** Each session's terminal, its history keeping, the rows a restart starts again and those whose history comes back. */
  readonly terms: Map<string, Term>;
  readonly histOf: Map<string, { touch: () => void; stop: () => void; flush: () => void }>;
  readonly termAgain: Set<string>;
  readonly histBack: Set<string>;
}

export function createTerminals(d: TerminalsDeps) {
  const { host, rec, patchRec, accountOf, nameOf, flag, tellEnd, setSessionFg, ready, terms, histOf, termAgain, histBack } = d;

  /** The app theme in force, as the terminal views last reported it. */
  let look: "dark" | "light" = "dark";

  /** How many times session `id`'s terminal was started again (Restart): the view keys its terminal on it. */
  const termRuns = new Map<string, number>();
  /** What stops following each session's foreground CLI (its pty's `session-fg` events). */
  const fgOff = new Map<string, () => void>();

  /** TERMINALS Codex sessions that do not know their conversation id yet: the next ask. A running Codex holds its
   *  own rollout open once its first prompt is answered, so while the row's Codex runs the shell is asked which
   *  conversation the Codex in that terminal's foreground holds open (rule 11: only the pty id goes out, only a UUID
   *  comes back), 5 s after it started and every 15 s after, until it names one; that is kept as the row's
   *  `agentSession` so a restart continues it (`codex resume <id>`) and the asking stops. A row only ever hears of the
   *  file its own process holds, so another row's conversation can never come to it. A Codex that ends stops the
   *  asking and hands its id to no row (its row goes on as its shell and is not resumed); one that never learned it
   *  comes back paused. */
  const codexIdTimer = new Map<string, ReturnType<typeof setTimeout>>();
  const findCodexId = (id: string, t: Term, run: number, pty: number, wait: number) => {
    if (!host.codexConversation) return;
    clearTimeout(codexIdTimer.get(id));
    const ask = async () => {
      codexIdTimer.delete(id);
      const live = () => terms.get(id) === t && t.run === run && !t.closed && t.hostId === pty && rec(id)?.agent === "codex" && !rec(id)?.agentSession;
      if (!live()) return;
      const got = await host.codexConversation!(pty).catch(() => null);
      if (!live()) return;
      if (got) patchRec(id, { agentSession: got });
      else findCodexId(id, t, run, pty, CODEX_ID_EVERY_MS);
    };
    codexIdTimer.set(id, setTimeout(() => void ask(), wait));
  };

  /** Whether the file of TERMINALS session `r`'s own conversation is where its CLI looks for it (rule 30, names
   *  only, in the home of the account it runs with); `unknown` when that could not be told. */
  const convState = async (r: SessionRec): Promise<ConvState> => {
    const agent = r.agent === "claude" || r.agent === "codex" ? r.agent : null;
    if (!host.conversationState || !r.agentSession || !agent) return "unknown";
    return host.conversationState(agent as "claude" | "codex", r.agentSession, accountOf(r)).catch(() => "unknown" as const);
  };

  /**
   * Start session `id`'s program in its terminal `t`. A Shell row runs the person's login shell; a CLI row runs its
   * CLI and, when that ends, goes on as the login shell in the same terminal (same scrollback, size and folder), so
   * the next CLI the person starts there is followed like any other (`session-fg`). When the shell of a TERMINALS row
   * ends the row closes, as its x does; a shell that ends with an error before the person typed anything (it could
   * not start properly) stays, with what it printed.
   */
  const startTerm = async (id: string, t: Term) => {
    const r = rec(id);
    if (!r) return;
    const run = ++t.run;
    const shell = isShell(r.agent);
    const io: TermIo = shell ? getShellHost() : host;
    t.io = io;
    t.hostId = null;
    t.closed = false;
    t.keyed = false;
    t.heard = false;
    t.keyedHeard = false;
    t.told = null;
    // the terminal view of a chat session does not decide the session's status; the chat does
    const ofChat = sessionMode(d.agents(), r) !== "terminal";
    // a TERMINALS Claude Code or Codex session that has its own conversation continues it: put back after a restart
    // (by itself, once) and on Restart; Claude Code's terminal view of a chat continues the chat's conversation
    if (!ofChat) termAgain.delete(id);
    const again = !ofChat && !!r.agentSession && TERM_CONTINUES.includes(r.agent);
    // a TERMINALS oh-my-hermes terminal is told its row's link (MANUT_TERMINAL_LINK): `omh` reopens by itself the
    // session it dropped in this terminal (after manut restarted, or on Restart), and no other program is told it
    const link = !ofChat && r.agent === "omh" && isLinkId(r.linkId) ? r.linkId : undefined;
    let resume = again ? r.agentSession : r.agentSession && ofChat && r.agent === "claude" ? r.agentSession : undefined;
    // any other Claude Code terminal starts a new conversation under an id manut makes, kept (once it started) so a
    // restart continues it
    let sessionId = !ofChat && !resume && r.agent === "claude" ? newConversationId() : undefined;
    // its conversation's file is looked for first (not after Claude Code refused that id as a new one). Absent: a
    // Claude Code conversation nobody used (no key pressed in it, no title of its own) was never written (Claude Code
    // writes it on the first message), so it starts again under the same id; a used one was deleted, and Codex has
    // nothing to continue: neither is started to refuse it
    const forced = !!t.resumeOnce;
    t.resumeOnce = false;
    let gone = false;
    if (again && !forced && (await convState(r)) === "absent") {
      if (t.run !== run) return;
      const used = !!(rec(id)?.used || rec(id)?.agentTitle);
      if (r.agent === "claude" && !used) {
        resume = undefined;
        sessionId = r.agentSession;
      } else gone = true;
    }
    if (t.run !== run) return;
    // what this terminal showed before manut restarted comes first, dimmed, under a divider (once)
    if (!ofChat && histBack.delete(id)) {
      const back = await restoredText(host, id);
      if (t.run !== run) return;
      if (back) feed(t.term, back);
    }
    if (!ofChat && !histOf.has(id)) {
      const h = trackHistory(host, id, () => (terms.get(id) === t && !isParked(t.raw) ? t.term : null));
      const flush = () => h.flush();
      t.el.addEventListener(PARKING_EVENT, flush);
      histOf.set(id, { ...h, stop: () => (t.el.removeEventListener(PARKING_EVENT, flush), h.stop()) });
    }
    if (gone) {
      // ended as a CLI that could not continue it ends (termEnd), keeping its conversation for Restart
      t.closed = true;
      feed(t.term, `\x1b[2m[${tr("ss.convGone", { agent: agentDef(r.agent).label })}]\x1b[0m\r\n`);
      patchRec(id, { status: "exited", exitCode: null, resumeFailed: true });
      tellEnd(id, "ended", { code: null });
      return;
    }
    const { cols, rows } = t.term;
    let marked = 0;
    // this program's pty id once known, and what was drawn of its output before that
    let pty: number | null = null;
    let owed = 0;
    // the TERMINALS card's second line: the last line on its screen with text, read a moment after output stops
    // flowing in (once per OUT_MARK_MS at most), from the terminal itself
    let lineTimer: ReturnType<typeof setTimeout> | null = null;
    const readLine = () => {
      lineTimer = null;
      const b = t.term.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < t.term.rows; y++) lines.push(b.getLine(b.baseY + y)?.translateToString(true) ?? "");
      const line = lastPrintedLine(lines) || undefined;
      // its own small store: a line change re-renders that one row, never the sessions list
      if (rec(id)) termActs.patch(id, { lastLine: line });
    };
    // parked before that read came (only an e2e's short thresholds allow it: a real park waits for a minute of
    // quiet): the line is read now, from the xterm being parked, so the read does not make it again
    const lineBeforePark = () => {
      if (t.run !== run) return t.el.removeEventListener(PARKING_EVENT, lineBeforePark);
      if (lineTimer === null) return;
      clearTimeout(lineTimer);
      readLine();
    };
    t.el.addEventListener(PARKING_EVENT, lineBeforePark);
    // a CLI started with the row's conversation id: whether it set up its screen before the person pressed a key in
    // it, and the last of what it printed (a refusal), read when it ends (termEnd)
    let drew = false;
    let drawn = 0;
    let said = "";
    const sayText = new TextDecoder();
    const onData = (d: Uint8Array | string) => {
      // every message is acknowledged once the terminal has taken it, in order: the shell reads the program
      // no further ahead of the page than its credit allows (to this program only: a replaced one is gone)
      const bytes = typeof d === "string" ? utf8.encode(d).length : d.byteLength;
      if (t.run === run) t.heard = true;
      if (again) {
        // only the end of a large message can be the end of the output
        const text = typeof d === "string" ? d.slice(-SAID_MAX) : sayText.decode(d.byteLength > SAID_MAX ? d.subarray(d.byteLength - SAID_MAX) : d, { stream: true });
        if (!drew && !t.keyedHeard) {
          drawn += bytes;
          drew = drawn > UI_BYTES || setsUpScreen(said.slice(-16) + text); // a sequence split between two messages
        }
        said = (said + text).slice(-SAID_MAX);
      }
      feed(t.term, d, () => {
        if (t.run !== run) return;
        if (pty === null) owed += bytes;
        else io.ack(pty, bytes);
      });
      histOf.get(id)?.touch();
      // the TERMINALS row's spinner and age: when output last flowed (throttled)
      const now = Date.now();
      if (!ofChat && now - marked >= OUT_MARK_MS) {
        marked = now;
        termActs.patch(id, { lastOut: now });
      }
      if (!ofChat && lineTimer === null) lineTimer = setTimeout(readLine, OUT_MARK_MS);
    };
    // when this program was asked for: a CLI continuing its conversation that ends soon after could not continue it
    const began = Date.now();
    try {
      const onExit = (code: number | null) => {
        // a program manut stopped (the row closed, Restart) or one already replaced says nothing more
        if (terms.get(id) !== t || t.run !== run) return;
        t.closed = true;
        termActs.patch(id, { progress: undefined });
        if (lineTimer !== null) clearTimeout(lineTimer);
        lineTimer = null;
        fgOff.get(id)?.();
        fgOff.delete(id);
        if (rec(id)?.fgAgent) setSessionFg(id, null);
        // its row was closed and waits to be undone: with the program gone there is nothing to undo
        if (t.held) {
          d.graceFinish(id);
          return;
        }
        // an agent CLI the shell of this app started has ended, maybe killed in the middle of its screen: the input modes it
        // died with (mouse, keys encoded, bracketed paste, the alternate screen) go back before the terminal goes on, as its
        // login shell or as it is (term/engine-reclaim.ts). A Shell row's own end reclaims nothing.
        programEnded(t.term, t.el, { agent: !shell });
        const label = agentDef(r.agent).label;
        // the look missed a conversation Claude Code has (it refused the id as a new one): continue it, once
        if (again && sessionId && !t.keyedHeard && idInUse(said, sessionId)) {
          t.resumeOnce = true;
          patchRec(id, { status: "starting", exitCode: null });
          void startTerm(id, t);
          return;
        }
        // a CLI that could not continue its conversation keeps it, ended, for Restart (termEnd)
        const end = termEnd({ ofChat, shell, keyed: shell ? t.keyed : t.keyedHeard, code, resumed: again, drew, refused: again && !!r.agentSession && refusedResume(said, r.agentSession), ms: Date.now() - began });
        if (end === "shell") {
          // the CLI ended: the same terminal goes on as the person's login shell in that folder
          feed(t.term, `\r\n\x1b[2m${code ? tr("ss.backToShellExit", { agent: label, code }) : tr("ss.backToShell", { agent: label })}\x1b[0m\r\n`);
          patchRec(id, { agent: SHELL, open: undefined, account: undefined, agentSession: undefined, agentTitle: undefined, used: undefined, startedAs: undefined, fgAgent: null, status: "starting", exitCode: null, error: undefined });
          void startTerm(id, t);
          return;
        }
        if (end === "close") {
          // exit, Ctrl+D: the row goes, as closing it with its x does (nothing runs, so no undo window)
          d.close(id);
          return;
        }
        if (!ofChat) {
          patchRec(id, { status: "exited", exitCode: code, ...(again ? { resumeFailed: true } : {}) });
          tellEnd(id, "ended", { code });
        }
        feed(t.term, `\r\n\x1b[2m[${code ? tr("ss.termEndedExit", { agent: label, code }) : tr("ss.termEnded", { agent: label })}]\x1b[0m\r\n`);
      };
      // a Shell row is the person's login shell (the bottom panel's `shell_start`: only a folder and a size go out)
      // this computer's name first, so the program's first OSC 7 already counts as local
      await learnThisHost();
      let hostId: number;
      if (shell) {
        const got = await getShellHost().start(r.cwd || null, cols, rows, onData, onExit, rec(id)?.shell);
        hostId = got.id;
        if (got.missing && t.run === run) {
          // the shell it was made with is gone from this computer: the default one runs, and the row says so once
          feed(t.term, `\x1b[33m${tr("term.shellMissing", { shell: got.missing })}\x1b[0m\r\n`);
          patchRec(id, { shell: undefined });
        }
        // the folder it was asked to start in is gone (the host starts it in home, `shell_cwd`): the row is listed
        // under the folder it runs in, never under the dead folder's header, and both the terminal and that header
        // say so
        const at = ranElsewhere(r.cwd, got.cwd);
        if (t.run === run && rec(id)) {
          if (at) {
            feed(t.term, `\x1b[33m${tr("term.folderGoneRan", { folder: r.cwd, at })}\x1b[0m\r\n`);
            patchRec(id, { cwd: at });
          }
          if (r.cwd) setFolderGone(r.cwd, !!at);
          // a collapsed group would hide its notice
          if (at) openFolderGroup(r.cwd);
        }
      } else hostId = await host.start(r.agent, workDir(r), cols, rows, onData, onExit, resume, accountOf(r), sessionId, link);
      if (t.run !== run) {
        // replaced while starting
        void io.close(hostId).catch(() => undefined);
        return;
      }
      t.hostId = hostId;
      pty = hostId;
      // the TERMINALS row's mark follows the CLI the shell sees in the foreground (`session-fg`)
      fgOff.get(id)?.();
      fgOff.set(id, onSessionFg(hostId, (agent) => setSessionFg(id, agent)));
      if (t.closed) {
        // closed while starting
        void io.close(hostId);
        return;
      }
      if (sessionId) patchRec(id, { agentSession: sessionId });
      if (owed) io.ack(hostId, owed);
      owed = 0;
      // the program started at this size; one that changed while it started is sent now
      t.told = { cols, rows };
      t.reflowed = false; // nothing was drawn by the program yet: no screen of its to redraw
      if (t.settle === null) tellSize(t);
      if (!ofChat) patchRec(id, { status: "running" });
      if (!ofChat && r.agent === "codex" && !rec(id)?.agentSession) findCodexId(id, t, run, hostId, CODEX_ID_FIRST_MS);
    } catch (e) {
      if (t.run !== run) return;
      t.closed = true;
      const error = errText(e);
      if (!ofChat) {
        patchRec(id, { status: "failed", error });
        tellEnd(id, "failed", { error });
      }
      feed(t.term, `\x1b[31m${error}\x1b[0m\r\n`);
    }
  };

  /** The person pressed a key or pasted in session `id`'s running program `t`. Once that is after its first output, a
   *  Claude Code or Codex row's conversation counts as used (kept with the row). */
  const pressed = (id: string, t: Term) => {
    t.keyed = true;
    if (!t.heard || t.keyedHeard) return;
    t.keyedHeard = true;
    const r = rec(id);
    if (r && !r.used && TERM_CONTINUES.includes(r.agent)) patchRec(id, { used: true });
  };

  /** Tell the program its terminal's size, if it is not the one it was last told. */
  const tellSize = (t: Term) => {
    t.settle = null;
    if (t.hostId === null || t.closed) return;
    const { cols, rows } = t.term;
    const same = t.told?.cols === cols && t.told.rows === rows;
    const reflowed = t.reflowed;
    t.reflowed = false;
    if (same && !reflowed) return;
    t.told = { cols, rows };
    const hostId = t.hostId;
    // Back at the size the program knows after xterm changed it and back (a show re-fits in the DOM renderer's cells,
    // then in the GPU's): xterm reflowed and trimmed its screen, the program saw no change and would never redraw it,
    // and a pty resize to the size it has sends no SIGWINCH. One size off and then the real one does, in that order.
    if (same) {
      void t.io
        .resize(hostId, cols + 1, rows)
        .catch(() => undefined)
        .then(() => t.io.resize(hostId, cols, rows))
        .catch(() => undefined);
      return;
    }
    void t.io.resize(hostId, cols, rows).catch(() => undefined);
  };

  const disposeTerm = (id: string) => {
    const t = terms.get(id);
    if (!t) return;
    // its history keeping follows the next terminal of the session (Restart), or ends with it
    histOf.get(id)?.stop();
    histOf.delete(id);
    clearTimeout(codexIdTimer.get(id));
    codexIdTimer.delete(id);
    fgOff.get(id)?.();
    fgOff.delete(id);
    if (t.hostId !== null && !t.closed) void t.io.close(t.hostId).catch(() => undefined);
    t.closed = true;
    if (t.settle !== null) clearTimeout(t.settle);
    const wasParked = isParked(t.raw);
    t.undo();
    if (!wasParked) t.raw.dispose(); // a parked one was disposed when it was parked
    t.el.remove();
    terms.delete(id);
  };

  /** Mount session `id`'s terminal into `container` (creating and starting it the first time). */
  const attach = (id: string, container: HTMLElement, mode: "dark" | "light"): (() => void) => {
    look = mode;
    if (xtermMods) return mount(xtermMods, id, container);
    let detach: (() => void) | null = null;
    let gone = false;
    void loadXterm().then((m) => {
      if (!gone) detach = mount(m, id, container);
    });
    return () => {
      gone = true;
      detach?.();
    };
  };

  const mount = ([{ Terminal }, { FitAddon }]: Xterm, id: string, container: HTMLElement, quiet = false): (() => void) => {
    const settings = readTermSettings();
    const theme = termTheme(look, settings);
    let t = terms.get(id);
    const fresh = !t;
    if (!t) {
      const el = document.createElement("div");
      el.className = "term-host";
      const make = (opts: ITerminalOptions & ITerminalInitOnlyOptions) => {
        const term = new Terminal(opts);
        const fit = new FitAddon();
        term.loadAddon(fit);
        return { term, fit };
      };
      const first = make(termOptions(theme, settings));
      t = {
        get term() {
          return live(this.raw);
        },
        raw: first.term,
        fit: first.fit,
        el,
        hostId: null,
        closed: false,
        undo: () => undefined,
        told: null,
        reflowed: false,
        settle: null,
        io: isShell(rec(id)?.agent) ? getShellHost() : host,
        run: 0,
        keyed: false,
        heard: false,
        keyedHeard: false,
      };
      terms.set(id, t);
      const tt = t;
      // file paths in its output open in the person's editor when they are inside the session's own folder (term/engine-paths.ts)
      setTermFolder(el, () => {
        const r = rec(id);
        return r ? workDir(r) || null : null;
      });
      // the person's own keys or paste reached the program (engine-input.ts, paste-guard.ts); the terminal's replies to
      // a program's queries also go out through onData and are not input
      // (keys while nothing runs there, or while its row waits to be undone, reach no program and do not count)
      el.addEventListener(TERM_INPUT_EVENT, () => {
        if (tt.hostId === null || tt.closed || tt.held) return;
        pressed(id, tt);
      });
      // a parked terminal made again: the same options and handlers, at the size it had, where it was
      tt.remake = ({ cols, rows }) => {
        const s = readTermSettings();
        const th = termTheme(look, s);
        const next = make({ ...termOptions(th, s), cols, rows });
        tt.raw = next.term;
        tt.fit = next.fit;
        wire(next.term);
        next.term.open(tt.el);
        tt.undo = afterOpen(next.term, tt.el, s, tt.remake);
        applyLook(next.term, th, s);
        return next.term;
      };
      const wire = (term: Terminal) => {
        term.onData((d) => {
          if (tt.hostId === null || tt.closed || tt.held) return;
          void tt.io.write(tt.hostId, d).catch(() => undefined);
        });
        // the title the program sets (OSC 0/2): the TERMINALS card's second line until it prints a line
        term.onTitleChange((title) => {
          const v = title.replace(/\s+/g, " ").trim().slice(0, LAST_LINE_MAX) || undefined;
          if (rec(id)) termActs.patch(id, { oscTitle: v });
        });
        term.onResize(() => {
          tt.reflowed = true;
          // the size it ends on is sent, once (a drag gives one size per frame)
          if (tt.settle !== null) clearTimeout(tt.settle);
          tt.settle = setTimeout(() => tellSize(tt), RESIZE_SETTLE_MS);
        });
        // The program rang the terminal's bell, as agents do when they wait for the person. manut reads nothing the
        // program prints: the bell is the one thing a terminal tells it. The row says so and a notification goes
        // out, once, until the person comes back to the session.
        const ring = () => {
          const r = rec(id);
          if (r && !tt.closed && flag(id, "bell")) d.notifyState()?.(id, { kind: "bell", name: nameOf(r), agent: termMarkAgent(r) !== null });
        };
        term.onBell(ring);
        // The notification escapes agents send instead of a bell count as a ring too: OSC 9 with a message (not a
        // `9;<number>` report such as the 9;4 progress bar) and OSC 777 `notify`. Their text is never shown or kept.
        term.parser.registerOscHandler(9, (d) => {
          if (!/^\d+(;|$)/.test(d)) ring();
          return false; // not consumed: another handler may want the escape
        });
        term.parser.registerOscHandler(777, (d) => {
          if (d.startsWith("notify;")) ring();
          return false;
        });
      };
      wire(first.term);
      // the folder its shell reports (OSC 7): the row's folder line. Progress (OSC 9;4): working while reported; done
      // after working, unseen, marks the row as the bell does (no notification: a report is not a ring). Both come
      // on the element, which a parked terminal made again keeps, and go with it.
      onCwd(el, (path) => {
        if (rec(id)) termActs.patch(id, { cwd: path });
      });
      onProgress(el, (st) => {
        if (!rec(id) || tt.closed) return;
        if (st === "busy") return termActs.patch(id, { progress: true });
        if (!termActs.get(id).progress) return;
        termActs.patch(id, { progress: undefined });
        flag(id, "bell");
      });
    }
    const tt = t;
    container.appendChild(tt.el);
    if (fresh) {
      tt.raw.open(tt.el);
      tt.undo = afterOpen(tt.raw, tt.el, settings, tt.remake);
    }
    applyLook(tt.term, theme, settings);
    const refit = () => {
      if (!tt.el.isConnected || tt.el.clientWidth === 0) return;
      // shown again with the GPU renderer on its way: fitted in the standard renderer's cells now, it is fitted again
      // in the GPU's, and the screen is reflowed twice. The engine's CELLS_EVENT fits it once, when they are known.
      if (!fresh && gpuComing(tt.raw)) return;
      try {
        tt.fit.fit();
      } catch {
        /* not measurable yet */
      }
    };
    // shown first: the engine then knows a GPU renderer is coming (`gpuComing`) when the first fit is made, and the
    // terminal is fitted again when its cells change size (CELLS_EVENT: the GPU renderer arrived, or went)
    tt.el.addEventListener(CELLS_EVENT, refit);
    onVisible(tt.term, true);
    refit();
    if (fresh) void ready().then(() => startTerm(id, tt));
    const ro = new ResizeObserver(refit);
    ro.observe(container);
    if (!quiet) tt.term.focus();
    return () => {
      ro.disconnect();
      tt.el.removeEventListener(CELLS_EVENT, refit);
      onVisible(tt.raw, false);
      if (tt.el.parentElement === container) container.removeChild(tt.el);
    };
  };

  /** A paused TERMINALS session's kept history (dimmed, under its divider), shown read-only in `container` until the
   *  person presses Resume: a terminal of its own that starts nothing, takes no keys and is not the session's
   *  terminal (Resume makes that one, which writes the same history back first). `shown` hears whether there was any. */
  const previewHistory = (id: string, container: HTMLElement, mode: "dark" | "light", shown: (has: boolean) => void): (() => void) => {
    let gone = false;
    let term: Terminal | null = null;
    let ro: ResizeObserver | null = null;
    if (!histBack.has(id)) {
      shown(false);
      return () => undefined;
    }
    void Promise.all([loadXterm(), restoredText(host, id)]).then(([[{ Terminal: Term }, { FitAddon }], text]) => {
      if (gone) return;
      if (!text) return shown(false);
      const s = readTermSettings();
      const theme = termTheme(mode, s);
      const t = (term = new Term({ ...termOptions(theme, s), disableStdin: true, cursorBlink: false }));
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(container);
      applyLook(t, theme, s);
      const refit = () => {
        if (!container.isConnected || container.clientWidth === 0) return;
        try {
          fit.fit();
        } catch {
          /* not measurable yet */
        }
      };
      refit();
      ro = new ResizeObserver(refit);
      ro.observe(container);
      // the kept text, and no cursor: nothing runs here
      t.write(`${text}\x1b[?25l`);
      shown(true);
    });
    return () => {
      gone = true;
      ro?.disconnect();
      term?.dispose();
    };
  };

  /** Type text at session `id`'s terminal prompt, as if the person had (a dropped file's path). */
  const typeAt = async (id: string, text: string) => {
    const t = terms.get(id);
    if (!t || t.hostId === null || t.closed || t.held) return;
    pressed(id, t);
    await t.io.write(t.hostId, text);
    t.term.focus();
  };

  /** Type a bot's prompt the person allowed (termShare.ts: the card's Allow, each request its own) into session
   *  `id`'s terminal, then Enter. A bracketed paste when the program turned that on, so a many-line prompt arrives as
   *  one (a parked terminal keeps the mode it had: term/engine.ts `bracketedPaste`); else its lines are typed as a
   *  paste types them. Control characters never reach the program (the prompt is
   *  cleaned before and here). Nothing else calls this. */
  const typeAllowed = async (id: string, prompt: string) => {
    const t = terms.get(id);
    if (!t || t.hostId === null || t.closed || t.held) return false;
    // eslint-disable-next-line no-control-regex
    const text = prompt.replace(/\r\n/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
    if (!text.trim()) return false;
    const bracketed = bracketedPaste(t.raw);
    await t.io.write(t.hostId, bracketed ? `\x1b[200~${text}\x1b[201~\r` : `${text.replace(/\n/g, "\r")}\r`);
    return true;
  };

  /** Files dropped or pasted on session `id`'s terminal: each saved under the session's own folder (the page
   *  never sees a dropped file's own path), then the saved paths typed at the prompt, shell-quoted (a paste when the
   *  program turned bracketed paste on: attach.ts `pathsTyped`). */
  const dropOnTerminal = async (id: string, files: { name: string; read: () => Promise<Uint8Array> }[], windows: boolean) => {
    const t = terms.get(id);
    if (t?.held) return; // closed, waiting to be undone: nothing is saved or typed
    const paths: string[] = [];
    for (const f of files) {
      try {
        paths.push(shellQuote(await host.saveFile(id, f.name, await f.read()), windows));
      } catch (e) {
        if (t) feed(t.term, `\r\n\x1b[31m${tr("att.failed", { name: f.name, error: errText(e) })}\x1b[0m\r\n`);
        return;
      }
    }
    const now = terms.get(id);
    if (paths.length && now) await typeAt(id, pathsTyped(paths, bracketedPaste(now.raw)));
  };


  /** Every open terminal takes the look again: the app theme changed, or a terminal setting did. */
  const relook = () => {
    const settings = readTermSettings();
    const theme = termTheme(look, settings);
    for (const t of terms.values()) {
      if (isParked(t.raw)) continue; // takes the look when it is made again
      applyLook(t.term, theme, settings);
      // a changed font or line height changes how many cells fit
      if (t.el.isConnected && t.el.clientWidth > 0) {
        try {
          t.fit.fit();
        } catch {
          /* not measurable yet */
        }
      }
    }
  };
  // Every session view calls this when it mounts and when the app theme changes: only a mode the terminals have not
  // been given yet relooks them all (each mount used to re-apply the look and refit every open terminal)
  let looked: "dark" | "light" | null = null;
  const setLook = (mode: "dark" | "light") => {
    look = mode;
    if (mode === looked) return;
    looked = mode;
    relook();
  };
  onTermSettings(relook);

  return {
    setLook,
    termRuns,
    startTerm,
    pressed,
    tellSize,
    disposeTerm,
    attach,
    mount,
    previewHistory,
    typeAt,
    typeAllowed,
    dropOnTerminal,
  };
}

export type Terminals = ReturnType<typeof createTerminals>;
