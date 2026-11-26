import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { BrokenLinkIcon, CheckIcon, CloudOffIcon, QrIcon } from "../../ui/marks";
import { Loading, Notice, OWNER_CARD as CARD, OWNER_TAP as TAP, OWNER_TOUCH as TOUCH, Pulse, whenText } from "../../ui/owner";
import type { AppStrings, MacStrings } from "../strings";
import type { PracticeBackend } from "./practice";
import { type AskNote, type AskState, MacRemote, type MacBackend, type MacView, type OpenChat } from "./remote";
import { browserScanner, type Scanner } from "./scan";
import type { OpenedLink } from "./setup";
import type { ApprovalAsk, AskView, ChatRow, ChatState, MessageView, QuestionAsk } from "./wire";

/// The Your Mac tab (docs/remote-access.md, "What a person does", steps 3 to 5): pair this phone with the person's Mac
/// by its code and the four digits, then watch the Mac's chats and answer their asks. It is drawn from `MacRemote`'s
/// state alone, and offers exactly four answers: Allow once (with the passkey), No, an answer to a question, and Stop. An
/// ask shows every word the Mac's card shows, whole. Nothing of a chat is kept, put in the address or sent anywhere but
/// to the Mac; a link in a reply is plain text and never opens from here.
///
/// Motion is the kit's own and only on what changes: an ask rises in once and stays still, and the answer's outcome
/// settles in (`rise`, `pop`, packages/ui-kit/app.css). Reduced motion stops both.

const H1: CSSProperties = { margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: "-.03em" };
const H2: CSSProperties = { margin: 0, fontSize: 17, fontWeight: 600 };
const SOFT: CSSProperties = { margin: 0, padding: "12px 14px", borderRadius: "var(--rad)", background: "var(--soft)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" };
/// A command, as the Mac's card shows it: whole, its line breaks kept, in the mono block, scrolling inside its own box once
/// it is taller than half the screen, so the answer buttons stay near and nothing of it is cut (item 117).
const COMMAND: CSSProperties = { ...SOFT, fontFamily: "var(--aui-font-mono)", fontSize: 13, maxHeight: "50vh", overflowY: "auto", overscrollBehavior: "contain" };

/// A command in its mono block, whole. While more of it is below the fold, its lower edge fades (app.css `.mac-cmd.more`),
/// as the Mac's card does, so the box reads as one that scrolls; the fade is gone once it is scrolled to its end.
function CommandBox({ text, testId }: { text: string; testId?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const [more, setMore] = useState(false);
  const measure = (el: HTMLElement) => setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure(el);
    const seen = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure(el));
    seen?.observe(el);
    return () => seen?.disconnect();
  }, [text]);
  return (
    <pre ref={ref} className={more ? "mac-cmd more" : "mac-cmd"} data-testid={testId} style={COMMAND} tabIndex={0} onScroll={(e) => measure(e.currentTarget)}>
      {text}
    </pre>
  );
}

const NOTE_TONE: Readonly<Record<AskNote, "ok" | "info" | "warn" | "err">> = {
  allowed: "ok",
  declined: "info",
  answered: "ok",
  stopped: "info",
  confirm: "warn",
  passkey_failed: "err",
  changed: "warn",
  closed: "info",
  gone: "info",
  not_offered: "warn",
  needs_update: "warn",
  busy: "warn",
  late: "warn",
  not_taken: "err",
  no_turn: "info",
  passkey_refused: "err",
  forgotten: "err",
  no_answer: "warn",
};

/// One `MacRemote` for as long as the tab is shown: made and started when it mounts, and its session closed and what
/// it showed forgotten when the person leaves the tab.
function useMacRemote(backend: MacBackend): { remote: MacRemote | null; view: MacView } {
  const [remote, setRemote] = useState<MacRemote | null>(null);
  const [view, setView] = useState<MacView>({ phase: "checking" });
  useEffect(() => {
    const made = new MacRemote(backend);
    setRemote(made);
    const off = made.subscribe(setView);
    void made.start();
    const visible = () => made.setVisible(document.visibilityState !== "hidden");
    const online = () => made.setOnline(true);
    const offline = () => made.setOnline(false);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      off();
      made.dispose();
    };
  }, [backend]);
  return { remote, view };
}

export function MacTab({
  s,
  backend,
  practice = null,
  opened = null,
  scanner: givenScanner,
  now = Date.now,
}: {
  s: AppStrings;
  backend: MacBackend;
  practice?: PracticeBackend | null;
  /// The pairing link the page was opened with, if any.
  opened?: OpenedLink | null;
  scanner?: Scanner;
  now?: () => number;
}) {
  const m = s.mac;
  const { remote, view } = useMacRemote(backend);
  if (!remote || view.phase === "checking") return <Loading label={m.checking} />;
  switch (view.phase) {
    case "unavailable":
      return (
        <>
          <h1 style={H1}>{m.title}</h1>
          <Notice icon={<CloudOffIcon />} title={m.unavailableTitle} body={m.unavailableBody} />
        </>
      );
    case "unpaired":
      return (
        <>
          <h1 style={H1}>{m.title}</h1>
          {practice && (
            <div className="banner info" role="note">
              <span className="grow">{m.practice}</span>
            </div>
          )}
          {view.failed ? (
            <section className="box" style={CARD} aria-labelledby="mac-failed-title">
              <h2 id="mac-failed-title" style={H2}>
                {m.failedTitle}
              </h2>
              <div className="banner err" role="alert">
                <span className="grow">{m.failed[view.failed]}</span>
              </div>
              <div>
                <button type="button" className="btn" style={TAP} onClick={() => remote.again()}>
                  {m.startAgain}
                </button>
              </div>
            </section>
          ) : (
            <CodeForm m={m} remote={remote} opened={opened} {...(givenScanner ? { scanner: givenScanner } : {})} />
          )}
        </>
      );
    case "pairing":
      return (
        <>
          <h1 style={H1}>{m.title}</h1>
          <PairingCard m={m} step={view.step} practice={practice} />
        </>
      );
    case "paired":
      return <Paired s={s} view={view} remote={remote} now={now} />;
  }
}

/// Scan, or paste the link; or, for a link the page was opened with outside the installed app, why it paired nothing.
function CodeForm({ m, remote, opened, scanner: given }: { m: MacStrings; remote: MacRemote; opened: OpenedLink | null; scanner?: Scanner }) {
  const [text, setText] = useState(() => (opened?.installed ? opened.link : ""));
  const [scanner, setScanner] = useState<Scanner | null>(given ?? null);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [empty, setEmpty] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stop = useRef<AbortController | null>(null);

  useEffect(() => {
    if (given) return;
    let live = true;
    void browserScanner().then((found) => live && setScanner(found));
    return () => {
      live = false;
    };
  }, [given]);
  // The camera stops when the tab goes away.
  useEffect(() => () => stop.current?.abort(), []);

  if (opened && !opened.installed) {
    return (
      <section className="box" style={CARD} aria-labelledby="mac-outside-title">
        <h2 id="mac-outside-title" style={H2}>
          {m.outsideTitle}
        </h2>
        <p style={{ margin: 0 }}>{m.outsideBody}</p>
        <div>
          <button
            type="button"
            className="btn dark"
            style={TAP}
            onClick={() => void navigator.clipboard?.writeText(opened.link).then(() => setCopied(true), () => undefined)}
          >
            {m.copyLink}
          </button>
        </div>
        {copied && (
          <p className="help" role="status" style={{ margin: 0 }}>
            {m.copied}
          </p>
        )}
      </section>
    );
  }

  const scan = async () => {
    if (!scanner?.available || scanning || !video.current) return;
    setScanNote(null);
    setScanning(true);
    const controller = new AbortController();
    stop.current = controller;
    const read = await scanner.scan(video.current, controller.signal);
    stop.current = null;
    setScanning(false);
    if (read === "refused") return setScanNote(m.cameraRefused);
    if (read === null) return;
    if (!/#pair=|^[A-Za-z0-9_-]{100,}$/.test(read.trim())) return setScanNote(m.scanNotCode);
    void remote.pair(read);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setEmpty(!text.trim());
    if (text.trim()) void remote.pair(text);
  };
  const canScan = scanner?.available === true;
  return (
    <section className="box" style={CARD} aria-labelledby="mac-scan-title">
      <h2 id="mac-scan-title" style={H2}>
        {m.scanTitle}
      </h2>
      <p className="hint" style={{ margin: 0 }}>
        {m.scanBody}
      </p>
      {/* The camera's picture, only while scanning. */}
      <video ref={video} playsInline muted aria-hidden="true" style={{ display: scanning ? "block" : "none", width: "100%", borderRadius: "var(--rad)", background: "var(--soft)" }} />
      {canScan && (
        <div>
          {scanning ? (
            <button type="button" className="btn" style={TAP} onClick={() => stop.current?.abort()}>
              {m.cancelScan}
            </button>
          ) : (
            <button type="button" className="btn dark" style={TAP} onClick={() => void scan()}>
              <QrIcon />
              {m.scan}
            </button>
          )}
        </div>
      )}
      {scanning && (
        <p className="help" role="status" style={{ margin: 0 }}>
          {m.scanning}
        </p>
      )}
      {scanner && !canScan && (
        <p className="hint" style={{ margin: 0 }}>
          {m.noScanner}
        </p>
      )}
      {scanNote && (
        <p className="help err" role="alert" style={{ margin: 0 }}>
          {scanNote}
        </p>
      )}
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="field">
          <label htmlFor="mac-link">{m.pasteLabel}</label>
          <input
            id="mac-link"
            className="input"
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setEmpty(false);
            }}
            aria-invalid={empty || undefined}
            aria-describedby="mac-link-help"
          />
          {empty ? (
            <span id="mac-link-help" className="help err" role="alert">
              {m.pasteFirst}
            </span>
          ) : (
            <span id="mac-link-help" className="help">
              {m.pasteHelp}
            </span>
          )}
        </div>
        <div>
          <button type="submit" className={canScan ? "btn" : "btn dark"} style={TAP}>
            {m.pair}
          </button>
        </div>
      </form>
    </section>
  );
}

function PairingCard({ m, step, practice }: { m: MacStrings; step: Extract<MacView, { phase: "pairing" }>["step"]; practice: PracticeBackend | null }) {
  switch (step.step) {
    case "connecting":
    case "finishing":
      return (
        <section className="box" style={{ ...CARD, flexDirection: "row", alignItems: "center" }} role="status">
          <Pulse />
          <span>{step.step === "connecting" ? m.connecting : m.finishing}</span>
        </section>
      );
    case "digits":
      return (
        <>
          <section className="box" style={CARD} aria-labelledby="mac-digits-title">
            <h2 id="mac-digits-title" style={H2}>
              {m.digitsTitle}
            </h2>
            <p
              role="img"
              aria-label={m.digitsSpoken(step.digits)}
              data-testid="mac-digits"
              style={{ margin: 0, display: "flex", gap: 16, fontSize: 44, lineHeight: 1.05, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}
            >
              {step.digits.split("").map((digit, i) => (
                <span key={i} aria-hidden="true">
                  {digit}
                </span>
              ))}
            </p>
            <p className="hint" style={{ margin: 0 }}>
              {m.digitsBody}
            </p>
            <p className="mut" role="status" style={{ margin: 0, display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <Pulse />
              {m.waitingForMac}
            </p>
          </section>
          {practice && (
            <div className="banner info" role="note">
              <span className="grow">{m.practiceDigits}</span>
              <button type="button" className="btn" style={TAP} onClick={() => practice.typeDigits()}>
                {m.practiceTypeDigits}
              </button>
            </div>
          )}
        </>
      );
    case "passkey":
      return (
        <section className="box" style={CARD} aria-labelledby="mac-passkey-title">
          <h2 id="mac-passkey-title" style={H2}>
            {m.passkeyTitle}
          </h2>
          <p style={{ margin: 0 }}>{m.passkeyBody}</p>
          {step.cancelled && (
            <div className="banner warn" role="alert">
              <span className="grow">{m.passkeyClosed}</span>
            </div>
          )}
          <div>
            {/* The prompt opens inside this tap, as Safari requires. */}
            <button type="button" className="btn dark" style={TAP} onClick={() => step.make()}>
              {m.makePasskey}
            </button>
          </div>
        </section>
      );
  }
}

function Paired({ s, view, remote, now }: { s: AppStrings; view: Extract<MacView, { phase: "paired" }>; remote: MacRemote; now: () => number }) {
  const m = s.mac;
  const live = view.link === "live";
  const when = (ms: number) => whenText(s, new Date(ms).toISOString(), now());
  const shown = view.open !== null || view.chats !== null;
  const greyed = !live && shown && !view.cleared;
  const status = live ? (
    <span className="tag ok" style={{ alignSelf: "flex-start" }}>
      {m.live}
    </span>
  ) : view.link === "connecting" && view.down === null ? (
    <p className="mut" role="status" style={{ margin: 0, display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
      <Pulse />
      {m.reaching}
    </p>
  ) : view.forgotten ? null : (
    <div className="banner warn" role="status">
      <CloudOffIcon />
      <span className="grow">
        {m.down(view.down ?? "lost", null)}
        {greyed && view.confirmedAt !== null ? ` ${m.greyed(when(view.confirmedAt))}` : ""}
      </span>
    </div>
  );

  if (view.forgotten) {
    return (
      <>
        <h1 style={H1}>{m.title}</h1>
        <Notice icon={<BrokenLinkIcon />} title={m.forgottenTitle} body={m.forgottenBody} />
        <Forget m={m} remote={remote} forgetting={view.forgetting} open />
      </>
    );
  }
  if (view.open) {
    return (
      <div data-greyed={greyed || undefined} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <button type="button" className="btn" style={TAP} onClick={() => remote.closeChat()}>
            {m.allChats}
          </button>
        </div>
        {status}
        <ChatScreen s={s} open={view.open} live={live} greyed={greyed} remote={remote} now={now} />
      </div>
    );
  }
  return (
    <>
      <h1 style={H1}>{m.title}</h1>
      {status}
      {view.cleared ? (
        <Notice icon={<CloudOffIcon />} title={m.clearedTitle} body={m.clearedBody} />
      ) : view.chats === null ? (
        <Loading label={m.loadingChats} />
      ) : view.chats.length === 0 ? (
        <Notice icon={<CheckIcon />} title={m.noChatsTitle} body={m.noChatsBody} />
      ) : (
        <div data-greyed={greyed || undefined} style={{ display: "flex", flexDirection: "column", gap: 14, ...(greyed ? { opacity: 0.6 } : {}) }}>
          {(["needs_you", "working", "done"] as const).map((state) => (
            <ChatGroup key={state} m={m} state={state} rows={view.chats!.filter((r) => r.state === state)} remote={remote} when={when} />
          ))}
        </div>
      )}
      <Forget m={m} remote={remote} forgetting={view.forgetting} />
    </>
  );
}

function ChatGroup({ m, state, rows, remote, when }: { m: MacStrings; state: ChatState; rows: ChatRow[]; remote: MacRemote; when: (ms: number) => string }) {
  if (rows.length === 0) return null;
  const id = `mac-group-${state}`;
  return (
    <section aria-labelledby={id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <h2 id={id} className="mut" style={{ margin: 0, fontSize: 13, fontWeight: 500 }}>
        {m.states[state]}
      </h2>
      <ul className="box" style={{ margin: 0, padding: 4, listStyle: "none", display: "flex", flexDirection: "column", gap: 2 }}>
        {rows.map((row) => (
          <li key={row.chat}>
            <button
              type="button"
              className="rowl"
              data-chat={row.chat}
              style={{ width: "100%", textAlign: "left", flexDirection: "column", alignItems: "flex-start", gap: 2 }}
              onClick={() => void remote.openChat(row.chat)}
            >
              <span style={{ fontWeight: 500, overflowWrap: "anywhere" }}>{row.title}</span>
              <span className="mut" style={{ fontSize: 12.5 }}>
                {m.updated(when(row.updatedAt * 1000))}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ChatScreen({ s, open, live, greyed, remote, now }: { s: AppStrings; open: OpenChat; live: boolean; greyed: boolean; remote: MacRemote; now: () => number }) {
  const m = s.mac;
  const view = open.view;
  const waiting = view.asks.filter((a) => a.open);
  const settled = view.asks.filter((a) => !a.open);
  const hasLink = view.messages.some((msg) => /https?:\/\//i.test(msg.text));
  const when = (seconds: number) => whenText(s, new Date(seconds * 1000).toISOString(), now());
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, ...(greyed ? { opacity: 0.6 } : {}) }}>
      <h1 style={H1}>{view.title}</h1>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className={`tag${view.state === "working" ? " run" : view.state === "needs_you" ? " warn" : ""}`}>{m.states[view.state]}</span>
        {view.step && (
          <span className="mut" style={{ fontSize: 13, minWidth: 0, overflowWrap: "anywhere" }}>
            {m.stepNow(view.step)}
          </span>
        )}
      </div>
      {waiting.length > 0 && (
        <section aria-label={m.asksTitle} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {waiting.map((ask) =>
            ask.kind === "approval" ? (
              <ApprovalCard key={ask.id} m={m} ask={ask} state={open.asks.get(ask.id) ?? null} live={live} remote={remote} />
            ) : (
              <QuestionCard key={ask.id} m={m} ask={ask} state={open.asks.get(ask.id) ?? null} live={live} remote={remote} />
            ),
          )}
        </section>
      )}
      {settled.length > 0 && (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
          {settled.map((ask) => (
            <SettledAsk key={ask.id} m={m} ask={ask} note={open.asks.get(ask.id)?.note ?? null} />
          ))}
        </ul>
      )}
      <section aria-labelledby="mac-messages-title" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 id="mac-messages-title" className="mut" style={{ margin: 0, fontSize: 13, fontWeight: 500 }}>
          {m.messagesTitle}
        </h2>
        {view.messages.map((message) => (
          <Message key={message.id} m={m} message={message} when={when} />
        ))}
        {hasLink && (
          <p className="hint" style={{ margin: 0 }}>
            {m.linksNote}
          </p>
        )}
      </section>
      {view.state !== "done" && live && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {open.stopNote && <NoteBanner m={m} note={open.stopNote} />}
          <div>
            <button type="button" className="btn" style={TAP} disabled={open.stopping} aria-busy={open.stopping || undefined} onClick={() => void remote.stop()}>
              {open.stopping ? (
                <>
                  <Pulse />
                  {m.stopping}
                </>
              ) : (
                m.stop
              )}
            </button>
          </div>
        </div>
      )}
      {view.state === "done" && open.stopNote && <NoteBanner m={m} note={open.stopNote} />}
    </div>
  );
}

/// A reply's words, as plain text: a link in one is never made something to tap (GoSpark's docs/remote.md).
function Message({ m, message, when }: { m: MacStrings; message: MessageView; when: (seconds: number) => string }) {
  const mine = message.role === "user";
  return (
    <article style={{ display: "flex", flexDirection: "column", gap: 4, ...(mine ? { padding: "10px 12px", borderRadius: "var(--rad-lg)", background: "var(--band)" } : { padding: "0 2px" }) }}>
      <span className="mut" style={{ fontSize: 12.5 }}>
        {`${mine ? m.you : m.reply}, ${when(message.ts)}`}
      </span>
      <p style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{message.text}</p>
    </article>
  );
}

function NoteBanner({ m, note }: { m: MacStrings; note: AskNote }) {
  const tone = NOTE_TONE[note];
  return (
    <div className={`banner ${tone} pop`} role={tone === "warn" || tone === "err" ? "alert" : "status"}>
      {tone === "ok" && <CheckIcon />}
      <span className="grow">{m.notes[note]}</span>
    </div>
  );
}

function AskFrom({ m, from }: { m: MacStrings; from: string | undefined }) {
  return from ? (
    <span className="mut" style={{ fontSize: 13, overflowWrap: "anywhere" }}>
      {m.askedBy(from)}
    </span>
  ) : null;
}

/// An approval, as the Mac's card shows it: who asks, the title (or "Start working on this plan?"), the whole command,
/// the plan and the folder. Allow once and No only, and only while the Mac is connected. A command too long for a phone
/// shows its start and says only the Mac can allow it; No stays. One the Mac keeps because it may hold a key says so, and
/// only No stays (item 121).
function ApprovalCard({ m, ask, state, live, remote }: { m: MacStrings; ask: ApprovalAsk; state: AskState | null; live: boolean; remote: MacRemote }) {
  const titleId = `mac-ask-${ask.id}`;
  const busy = state?.busy ?? null;
  const offersOnce = ask.offers.includes("once");
  const offersNo = ask.offers.includes("deny");
  const answerable = live && !ask.needsUpdate && (offersOnce || offersNo);
  const settled = state?.note === "allowed" || state?.note === "declined";
  return (
    <article className="box rise" style={CARD} aria-labelledby={titleId} data-ask={ask.id}>
      <AskFrom m={m} from={ask.from} />
      <p className="big" id={titleId}>
        {ask.plan ? m.startPlan : ask.title || m.approvalNeeded}
      </p>
      {ask.command && <CommandBox text={ask.command} testId="mac-command" />}
      {ask.long && (
        <p className="hint" style={{ margin: 0 }} data-testid="mac-command-long">
          {m.tooLongHere}
        </p>
      )}
      {ask.keyed && (
        <p className="hint" style={{ margin: 0 }} data-testid="mac-command-keyed">
          {m.keyedHere}
        </p>
      )}
      {ask.plan && <p style={SOFT}>{ask.plan}</p>}
      {ask.cwd && (
        <p className="hint" style={{ margin: 0, overflowWrap: "anywhere" }}>
          {m.inCwd(ask.cwd)}
        </p>
      )}
      {state?.note && <NoteBanner m={m} note={state.note} />}
      {state?.confirm && live ? (
        <div>
          <button type="button" className="btn dark" style={TAP} onClick={() => state.confirm?.()}>
            {m.confirm}
          </button>
        </div>
      ) : answerable && !settled ? (
        <div className="chips">
          {offersOnce && (
            <button
              type="button"
              className="btn dark"
              style={TOUCH}
              disabled={busy !== null}
              aria-busy={busy === "allow" || undefined}
              onClick={() => void remote.allowOnce(ask.id)}
            >
              {busy === "allow" ? (
                <>
                  <Pulse />
                  {m.allowing}
                </>
              ) : (
                m.allowOnce
              )}
            </button>
          )}
          {offersNo && (
            <button type="button" className="btn" style={TOUCH} disabled={busy !== null} aria-busy={busy === "no" || undefined} onClick={() => void remote.no(ask.id)}>
              {busy === "no" ? (
                <>
                  <Pulse />
                  {m.sayingNo}
                </>
              ) : (
                m.no
              )}
            </button>
          )}
        </div>
      ) : !settled ? (
        <p className="hint" style={{ margin: 0 }}>
          {live ? m.onlyOnMac : m.answerWhenBack}
        </p>
      ) : null}
    </article>
  );
}

/// What the Mac reads back for a question (apps/desktop/src/chat/cards/answers.ts `answerOf`): the choice or the typed
/// text, a JSON list of choices for one that takes several, or null when skipped.
export function answerOf(chosen: readonly string[], other: string, multi: boolean): string | null {
  const typed = other.trim();
  if (multi) {
    const all = [...chosen, ...(typed ? [typed] : [])];
    return all.length ? JSON.stringify(all) : null;
  }
  return typed || chosen[0] || null;
}

type Pick = { chosen: string[]; other: string };

function Choices({
  idBase,
  question,
  hideQuestion = false,
  choices,
  multi,
  pick,
  disabled,
  onChange,
  m,
}: {
  idBase: string;
  question: string;
  /// The question is already the card's title: said to a screen reader only.
  hideQuestion?: boolean;
  choices: readonly string[];
  multi: boolean;
  pick: Pick;
  disabled: boolean;
  onChange: (pick: Pick) => void;
  m: MacStrings;
}) {
  return (
    <fieldset style={{ margin: 0, padding: 0, border: 0, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <legend className={hideQuestion ? "vh" : "lab"} style={{ padding: 0, marginBottom: 4, overflowWrap: "anywhere" }}>
        {question}
      </legend>
      {choices.map((choice) => {
        const on = pick.chosen.includes(choice);
        return (
          <button
            key={choice}
            type="button"
            className="pick"
            aria-pressed={on}
            disabled={disabled}
            style={{ textAlign: "left", overflowWrap: "anywhere" }}
            onClick={() => onChange({ ...pick, chosen: multi ? (on ? pick.chosen.filter((c) => c !== choice) : [...pick.chosen, choice]) : on ? [] : [choice] })}
          >
            {/* The kit's row: the choice, then its mark at the end (packages/ui-kit/app.css, .pick and .dot). */}
            <span>{choice}</span>
            <span className="dot" aria-hidden="true">
              <CheckIcon />
            </span>
          </button>
        );
      })}
      <div className="field">
        <label htmlFor={`${idBase}-other`}>{choices.length > 0 ? m.otherLabel : m.answerLabel}</label>
        <input id={`${idBase}-other`} className="input" type="text" value={pick.other} disabled={disabled} onChange={(e) => onChange({ ...pick, other: e.target.value })} />
      </div>
    </fieldset>
  );
}

/// A question, or an interview of several, answered by choosing or typing. Nothing goes until Send is pressed.
function QuestionCard({ m, ask, state, live, remote }: { m: MacStrings; ask: QuestionAsk; state: AskState | null; live: boolean; remote: MacRemote }) {
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [unready, setUnready] = useState(false);
  const titleId = `mac-ask-${ask.id}`;
  const busy = state?.busy === "answer";
  const settled = state?.note === "answered";
  const interview = ask.questions ?? null;
  const pickOf = (id: string): Pick => picks[id] ?? { chosen: [], other: "" };
  const set = (id: string, pick: Pick) => {
    setUnready(false);
    setPicks((all) => ({ ...all, [id]: pick }));
  };
  const single = answerOf(pickOf("").chosen, pickOf("").other, !!ask.multi);
  const answers = interview ? Object.fromEntries(interview.map((q) => [q.id, answerOf(pickOf(q.id).chosen, pickOf(q.id).other, !!q.multi)])) : null;
  const ready = interview ? Object.values(answers!).some((a) => a !== null) : single !== null;
  const send = () => {
    if (interview && answers) void remote.answer(ask.id, answers);
    else if (single !== null) void remote.answer(ask.id, single);
  };
  return (
    <article className="box rise" style={CARD} aria-labelledby={titleId} data-ask={ask.id}>
      <AskFrom m={m} from={ask.from} />
      <p className="big" id={titleId} style={{ overflowWrap: "anywhere" }}>
        {ask.question}
      </p>
      {state?.note && <NoteBanner m={m} note={state.note} />}
      {state?.confirm && live ? (
        <div>
          {/* The passkey prompt opens inside this tap, as Safari requires. */}
          <button type="button" className="btn dark" style={TAP} onClick={() => state.confirm?.()}>
            {m.confirm}
          </button>
        </div>
      ) : live && !settled ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setUnready(!ready);
            if (ready && !busy) send();
          }}
          style={{ display: "flex", flexDirection: "column", gap: 12 }}
        >
          {interview ? (
            <>
              {interview.map((q) => (
                <Choices key={q.id} idBase={`${titleId}-${q.id}`} question={q.question} choices={q.choices ?? []} multi={!!q.multi} pick={pickOf(q.id)} disabled={busy} onChange={(p) => set(q.id, p)} m={m} />
              ))}
              <p className="hint" style={{ margin: 0 }}>
                {m.skipHint}
              </p>
            </>
          ) : (
            <Choices idBase={titleId} question={ask.question} hideQuestion choices={ask.choices ?? []} multi={!!ask.multi} pick={pickOf("")} disabled={busy} onChange={(p) => set("", p)} m={m} />
          )}
          {unready && (
            <p className="help err" role="alert" style={{ margin: 0 }}>
              {m.answerFirst}
            </p>
          )}
          <div>
            <button type="submit" className="btn dark" style={TAP} disabled={busy} aria-busy={busy || undefined}>
              {busy ? (
                <>
                  <Pulse />
                  {m.sending}
                </>
              ) : (
                m.sendAnswer
              )}
            </button>
          </div>
        </form>
      ) : !settled ? (
        <p className="hint" style={{ margin: 0 }}>
          {m.answerWhenBack}
        </p>
      ) : null}
    </article>
  );
}

function SettledAsk({ m, ask, note }: { m: MacStrings; ask: AskView; note: AskNote | null }) {
  const words = ask.kind === "approval" ? (ask.plan ? m.startPlan : ask.title || m.approvalNeeded) : ask.question;
  return (
    <li className="box" style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }} data-ask={ask.id}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {ask.outcome && <span className={`tag${ask.outcome === "allowed" || ask.outcome === "answered" ? " ok" : ""}`}>{m.outcomes[ask.outcome]}</span>}
        <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{words}</span>
      </div>
      {ask.kind === "approval" && ask.command && <CommandBox text={ask.command} />}
      {note && note !== "allowed" && note !== "declined" && note !== "answered" && <NoteBanner m={m} note={note} />}
    </li>
  );
}

/// Forget this Mac, said twice: what it removes, and that the Mac keeps listing this phone until it is unpaired there.
function Forget({ m, remote, forgetting, open = false }: { m: MacStrings; remote: MacRemote; forgetting: boolean; open?: boolean }) {
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!asking) {
    return (
      <div style={{ marginTop: open ? 0 : 8 }}>
        <button type="button" className={open ? "btn dark" : "btn"} style={TAP} onClick={() => setAsking(true)}>
          {m.forget}
        </button>
      </div>
    );
  }
  return (
    <section className="box" style={CARD} aria-labelledby="mac-forget-title">
      <h2 id="mac-forget-title" style={H2}>
        {m.forgetTitle}
      </h2>
      <p style={{ margin: 0 }}>{m.forgetBody}</p>
      {failed && (
        <div className="banner err" role="alert">
          <span className="grow">{m.forgetFailed}</span>
        </div>
      )}
      <div className="chips">
        <button
          type="button"
          className="btn danger"
          style={TOUCH}
          disabled={forgetting}
          aria-busy={forgetting || undefined}
          onClick={() => void remote.forget().then((done) => setFailed(!done))}
        >
          {forgetting ? m.forgetting : m.forgetConfirm}
        </button>
        <button type="button" className="btn" style={TOUCH} disabled={forgetting} onClick={() => setAsking(false)}>
          {m.keep}
        </button>
      </div>
    </section>
  );
}
