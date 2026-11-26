// Approval and clarify cards (timeline slot "cards"). While open: a small card with buttons. Once answered
// (or once its turn is over, or the gateway gave up on it) it collapses to one gray line.
//
// Keys, only while the card has focus (never global): on an approval 1 / 2 / 3 = Deny / Allow once / Allow for
// session; on a question the digit of a numbered choice picks it ("Other…" is the last number, never while typing
// in a field or composing) and Enter picks the focused choice or sends the text. The sidebar's Needs-you strip and ⌘J
// scroll a card into view and focus it.
//
// An ask from one of several shops (docs/several-shops.md) names its shop at the top, and offers what the person's role
// there allows: where a helper may not decide (money, a public post, a payment, a command) the card says who may, and
// offers Ask <owner> instead, which passes the request on with a note, once; a note passed on shows on the card, in the
// canvas's People board words ("Passed on by Mint", "Mint: <note>").
import "./cards.css";
import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref, type RefObject } from "react";
import type { SlotProps } from "../../features";
import type { ApprovalChoice, AskSubagent, ClarifyAnswers, ClarifyQuestion } from "../../lib/protocol";
import { useShowingCache } from "../../runtime/link";
import { useLanded } from "../parts/arrival";
import { askOpen, getStore, shopName, useStore, type ApprovalItem, type AskExpiry, type ClarifyItem } from "../../state/store";
import { answerOf, EMPTY, type Pick } from "./answers";
import { clearAskNote, useAskNote } from "./askNote";
import { choiceIndexForKey, parseChoice } from "./choices";
import { ALLOW_LABEL, passOn, respond, settleApproval } from "./respond";
import { shopAskLines } from "../../lib/shops";
import { riskOf } from "./risk";
import { t, type Key } from "../../i18n";
import { Markdown } from "../parts/Markdown";
import { composing, holdImeEnter } from "../../lib/ime";
import { maskCommand, maskSecrets } from "../../lib/secrets";
import { KitSays, kitButtons, kitDoneText, useKitCard } from "../../code/KitCardParts";
import { addRule, updateKitProjects } from "../../code/project";
import { computerAsk } from "../../computer/computer";
import { computerWords } from "./computerCard";

export const slot = "cards";

const EXPIRED_LABEL: Record<AskExpiry, Key> = {
  timeout: "card.timedOut",
  resolved: "card.answeredElsewhere",
  cancelled: "card.notAnswered",
};

/** Buttons in display order; only those the request offers are shown. Deny comes first so the left-most, first-tabbed
 *  answer is the safe one, and no answer is ever the card's default: Enter on the card does nothing, and a number key
 *  answers only while the card has focus. The design canvas draws Allow once as the card's one black button and the
 *  others quiet (cards.css); that is the look only, the order and the keys are these. `key` is its number while the card
 *  has focus. */
const BUTTONS: { choice: ApprovalChoice; label: Key; key: string }[] = [
  { choice: "deny", label: "card.deny", key: "1" },
  { choice: "once", label: "card.allowOnce", key: "2" },
  { choice: "session", label: "card.allowSession", key: "3" },
];

/** A command in the card's mono block, whole (item 117). A long one scrolls inside the block, by keyboard too (Home and End
 *  move the command, not the chat, whose End jumps to its bottom), and while more of it is below the fold its lower edge
 *  fades, as a long list of agents does (sessions.css `.ss-scroll.more`), so the block reads as one that scrolls; the fade
 *  is gone once it is scrolled to its end. */
function CommandBlock({ text }: { text: string }) {
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
    <pre
      ref={ref}
      className={more ? "card-cmd more" : "card-cmd"}
      data-testid="card-command"
      tabIndex={0}
      aria-label={t("card.command")}
      onScroll={(e) => measure(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === "Home" || e.key === "End") e.stopPropagation();
      }}
    >
      {text}
    </pre>
  );
}

/** Cards already scrolled to for a given focus request, so a re-mount does not steal focus again. */
const handled = new Set<number>();

/** Scrolls the card into view and focuses it when the Needs-you strip or ⌘J asked for it. */
function useFocusRequest(bot: string, id: string, ref: RefObject<HTMLElement | null>, open: boolean) {
  const req = useStore().ui.focusAsk;
  useEffect(() => {
    if (!open || !req || req.bot !== bot || req.id !== id || handled.has(req.seq)) return;
    const el = ref.current;
    if (!el) return;
    handled.add(req.seq);
    el.scrollIntoView({ block: "center" });
    el.focus({ preventScroll: true });
  }, [req, bot, id, open, ref]);
}

/** A closed card's one line. `ok`: an Allow, whose tick takes the green of done. */
function Line({ icon, text, detail, testid, landed, ok }: { icon: string; text: string; detail?: string; testid: string; landed?: boolean; ok?: boolean }) {
  return (
    <div className={`line card-line${ok ? " ok" : ""}${landed ? " landed" : ""}`} data-testid={testid}>
      <span className="line-ic">{icon}</span>
      <span className="line-t">
        {text}
        {detail && <span className="card-line-d"> · {detail}</span>}
      </span>
    </div>
  );
}

function useOpen(bot: string, item: ApprovalItem | ClarifyItem): boolean {
  const items = useStore().chats[bot]?.items ?? [];
  return askOpen(items, item);
}

function Approval({ bot, item }: { bot: string; item: ApprovalItem }) {
  const open = useOpen(bot, item);
  const state = useStore();
  const shop = item.shop ? shopName(state, item.shop) : "";
  // The runtime can show only a kept read of the shop while the API cannot be reached: the ask is there to read, but
  // answering needs the live record, so no answer is offered (the runtime refuses one too).
  const kept = useShowingCache();
  // An ask this version cannot answer (a kind or a state it does not know) offers no answer at all, connected or not:
  // the runtime sends nothing for it, and the card says to update the app.
  const outdated = !!item.outdated;
  const [busy, setBusy] = useState<ApprovalChoice | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // a helper writing the note that goes to the owner with the request (Ask <owner>), and whether it is on its way
  const [note, setNote] = useState<string | null>(null);
  const [passing, setPassing] = useState(false);
  // what became of an Approve pressed on a notification, which the app had no card on screen to show (askNote.ts)
  const noted = useAskNote(item.request_id);
  const ref = useRef<HTMLDivElement>(null);
  useFocusRequest(bot, item.id, ref, open);
  // a closed card's line names the shop too, so a list of them from several shops still says whose each was; a key in
  // the command is never shown there (maskCommand), as on a coding session's ask
  // a computer use card (item 82) is drawn in the person's language from what the shell named (computerCard.ts)
  const comp = computerAsk(item.tool?.computer);
  const said = comp ? computerWords(comp) : null;
  const detail = [shop, said ? said.title : item.command ? maskCommand(item.command) : maskSecrets(item.title)].filter(Boolean).join(" · ");
  // a coding session's ask, read as one of Kit's steps (src/code/): its words, and Always allow in this project
  const kit = useKitCard(bot, item);

  // Allow or No landing while the person watched settles into the row; a card that was decided before it mounted is still
  const landed = useLanded(!!item.resolved);
  if (item.resolved) {
    const denied = item.resolved === "deny";
    // an ask Kit's dial answered by itself says how
    return <Line icon={denied ? "✕" : "✓"} text={kitDoneText(bot, item.request_id) ?? t(ALLOW_LABEL[item.resolved])} detail={detail} testid="card-line" landed={landed} ok={!denied} />;
  }
  // the runtime's own words for why it stopped waiting ("Already decided by Mint at 19:42"), when it gave them
  if (item.expired && !busy) return <Line icon="–" text={item.expiredNote || t(EXPIRED_LABEL[item.expired])} detail={detail} testid="card-line" />;
  if (!open && !busy) return <Line icon="–" text={t("card.notAnswered")} detail={detail} testid="card-line" />;

  /** `keep`: Always allow in this project, which allows this one ask once and then keeps the project's rule. */
  const pick = async (choice: ApprovalChoice, keep = false) => {
    if (busy || kept || outdated) return;
    setBusy(choice);
    setErr(null);
    clearAskNote(item.request_id);
    // Home's Approve, and Approve on a notification, settle through this same call (respond.ts), so there is one way an
    // approval is answered.
    const e = await settleApproval(getStore(), bot, item, choice);
    // the rule is kept only once the ask itself was taken: an approval covers this one ask, the rule the next ones
    const rule = keep && !e ? kit?.always : null;
    if (kit && rule) updateKitProjects((p) => addRule(p, kit.root, rule));
    setErr(e);
    setBusy(null);
  };
  const shown: { choice: ApprovalChoice; label: Key; key: string; keep?: true }[] = kit ? kitButtons(kit, item.choices) : BUTTONS.filter((b) => item.choices.includes(b.choice));
  const { only, passed } = shopAskLines(item);
  const owner = item.shop?.owner ?? "";
  const sendNote = async () => {
    if (passing || kept || note === null || !note.trim()) return;
    setPassing(true);
    setErr(null);
    const e = await passOn(getStore(), bot, item, note);
    setErr(e);
    setPassing(false);
    if (e === null) setNote(null);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const b = shown.find((x) => x.key === e.key);
    if (!b) return;
    e.preventDefault();
    void pick(b.choice, !!b.keep);
  };

  // a computer use card's lines are an app's words, not a command: no command risk is read in them
  const risks = said ? [] : riskOf(item.command || "");
  // plan mode's end asks one thing in plain words: start on the plan below
  const title = item.plan ? t("card.startPlan") : said ? said.title : item.title || t("card.approvalNeeded");
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className={`card${risks.length ? " risky" : ""}`}
      data-testid="card-approval"
      role="group"
      aria-label={title}
      aria-keyshortcuts={kept || outdated ? undefined : shown.map((b) => b.key).join(" ")}
      onKeyDown={onKey}
    >
      <AskedBy who={item.subagent} />
      {shop && (
        <div className="card-shop" data-testid="card-shop">
          {shop}
        </div>
      )}
      <div className="card-title">{title}</div>
      {risks.length > 0 && (
        <div className="card-risk" data-testid="card-risk" role="note">
          {risks.join(" · ")}
        </div>
      )}
      {/* a browser write's sentence is read whole before it is approved, exactly as the API wrote it: its block grows
          with it (cards.css .whole), and nothing in it is masked, since what is approved must be what is typed. Every
          other command arrives whole, its line breaks kept, and hides only the keys in it (maskCommand: never a
          substitution, a pipe or a second command); a long one scrolls in its block, which the keyboard can scroll too
          (item 117). */}
      {said ? (
        <>
          <pre className="card-cmd whole" data-testid="card-computer">
            {said.lines}
          </pre>
          {/* the control as it looked at the ask (the shell's picture of just that part of the window), beside its name */}
          {comp?.picture && <img className="card-computer-picture" data-testid="card-computer-picture" src={`data:image/png;base64,${comp.picture}`} alt={t("computer.ask.picture", { app: comp.app })} />}
        </>
      ) : (
        item.command &&
        (item.whole ? (
          <pre className="card-cmd whole">{item.command}</pre>
        ) : (
          <CommandBlock text={maskCommand(item.command)} />
        ))
      )}
      {kit && <KitSays card={kit} />}
      {/* plan mode's plan: the agent's markdown as an answer reads, whole, scrolling inside the card */}
      {item.plan && (
        <div className="card-plan md" data-testid="card-plan">
          <Markdown text={item.plan} />
        </div>
      )}
      {item.cwd && (
        <div className="card-cwd" title={item.cwd} data-testid="card-cwd">
          {t("card.inCwd", { cwd: item.cwd })}
        </div>
      )}
      {passed && (
        <div className="card-passed" data-testid="card-passed">
          <div className="card-passed-h">{passed.title}</div>
          <div className="card-passed-n">{passed.note}</div>
        </div>
      )}
      {only && (
        <div className="card-note card-only" data-testid="card-only">
          {only}
        </div>
      )}
      {note !== null && item.passOn && (
        <form
          className="card-pass"
          onSubmit={(e) => {
            e.preventDefault();
            void sendNote();
          }}
        >
          <textarea
            className="card-in card-pass-in"
            value={note}
            rows={2}
            maxLength={500}
            autoFocus
            disabled={passing || kept}
            aria-label={t("card.passNote", { owner })}
            placeholder={t("card.passNote", { owner })}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              // the card's number keys are for its buttons, never for a note being written
              e.stopPropagation();
              if (e.key === "Escape" && !composing(e)) setNote(null);
            }}
            data-testid="card-pass-note"
          />
          <div className="card-acts">
            <button type="submit" className="card-btn soft once" disabled={passing || kept || !note.trim()} data-testid="card-pass-send">
              {t("card.passSend", { owner })}
            </button>
            <button type="button" className="card-btn soft" disabled={passing} onClick={() => setNote(null)}>
              {t("card.passCancel")}
            </button>
          </div>
        </form>
      )}
      <div className="card-acts">
        {shown.map((b) => (
          <button key={b.key} type="button" className={`card-btn soft ${b.keep ? "always" : b.choice}`} data-choice={b.keep ? "always" : b.choice} disabled={!!busy || kept} onClick={() => void pick(b.choice, !!b.keep)}>
            {t(b.label)}
          </button>
        ))}
        {item.passOn && note === null && (
          <button type="button" className="card-btn soft" disabled={kept || passing} onClick={() => setNote("")} data-testid="card-ask-owner">
            {t("card.askOwner", { owner })}
          </button>
        )}
        {outdated ? (
          <span className="card-note" data-testid="card-outdated">
            {t("rt.updateToAnswer")}
          </span>
        ) : kept ? (
          <span className="card-note" data-testid="card-offline">
            {t("rt.connectToAnswer")}
          </span>
        ) : (
          <span className="card-keys" aria-hidden="true">
            {shown.map((b) => b.key).join(" · ")}
          </span>
        )}
        {(err ?? noted) && <span className="card-err">{t("card.notSent", { error: (err ?? noted) as string })}</span>}
      </div>
    </div>
  );
}


/** What a card needs from its question: the digit-key handler, for a card whose own frame has the focus. */
interface QuestionKeys {
  key: (e: KeyboardEvent<HTMLElement>) => void;
}

/** One question's choices as numbered rows, one per line (gray when selected), plus a free-text "Other" as the
 *  last number, or just the text field. A row shows the choice without a trailing "(Recommended)" / "(권장)" (a
 *  badge instead) and splits a " — " into a title and a dimmer description; the answer is still the choice as
 *  given. The "Other…" row looks like its siblings and, once clicked, opens a text field as wide as the rows;
 *  emptied and left, it folds back into the row. `onPickOne` answers a single-select question at once. */
function QuestionInput({
  q,
  pick,
  disabled,
  onChange,
  index,
  onPickOne,
  onSubmitOther,
  flat,
  keys,
}: {
  q: ClarifyQuestion;
  pick: Pick;
  disabled: boolean;
  onChange: (p: Pick) => void;
  index: number;
  onPickOne?: (c: string) => void;
  onSubmitOther?: () => void;
  flat?: boolean;
  keys?: Ref<QuestionKeys>;
}) {
  const choices = q.choices?.filter((c) => c.trim()) ?? [];
  const multi = !!q.multi_select && choices.length > 0;
  const [otherOpen, setOtherOpen] = useState(false);
  const otherRef = useRef<HTMLInputElement>(null);
  const toggle = (c: string) => {
    if (onPickOne && !multi) return onPickOne(c);
    const on = pick.chosen.includes(c);
    if (multi) onChange({ ...pick, chosen: on ? pick.chosen.filter((x) => x !== c) : [...pick.chosen, c] });
    else onChange({ chosen: on ? [] : [c], other: "" });
  };
  const openOther = () => {
    setOtherOpen(true);
    otherRef.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    const i = choiceIndexForKey(e, choices.length + 1);
    if (i < 0) return;
    e.preventDefault();
    if (i === choices.length) openOther();
    else toggle(choices[i]);
  };
  useImperativeHandle(keys, () => ({ key: onKey }));
  if (!choices.length) {
    return (
      <input
        className="card-in iv-in"
        value={pick.other}
        disabled={disabled}
        placeholder={t("card.answerOpt")}
        aria-label={t("card.answerN", { n: index + 1 })}
        onChange={(e) => onChange({ chosen: [], other: e.target.value })}
      />
    );
  }
  const showOther = otherOpen || !!pick.other;
  return (
    <div className={`iv-chips${flat ? " flat" : ""}`} role={multi || onPickOne ? "group" : "radiogroup"} aria-label={q.question} onKeyDown={flat ? undefined : onKey}>
      {/* the Other row stays in the list (pressed while its field is open); the field takes the next line */}
      {choices.map((c, i) => {
        const on = pick.chosen.includes(c);
        const { title, desc, recommended } = parseChoice(c);
        return (
          <button
            key={c}
            type="button"
            className={`iv-chip${on ? " on" : ""}`}
            role={onPickOne && !multi ? undefined : multi ? "checkbox" : "radio"}
            aria-checked={onPickOne && !multi ? undefined : on}
            aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
            disabled={disabled}
            onClick={(e) => {
              e.currentTarget.focus(); // WebKit (macOS) does not focus a button on click; the digit keys need it
              toggle(c);
            }}
          >
            <span className="iv-num" aria-hidden="true">{i + 1}</span>
            {multi && <span className="iv-box" aria-hidden="true">{on ? "✓" : ""}</span>}
            <span className="iv-body">
              <span className="iv-title">
                {title}
                {recommended && " "}
                {recommended && <span className="iv-badge">{t("card.recommended")}</span>}
              </span>
              {desc && <span className="iv-desc">{desc}</span>}
            </span>
          </button>
        );
      })}
      <button
        type="button"
        className={`iv-chip iv-more${showOther ? " open" : ""}${pick.other.trim() ? " on" : ""}`}
        aria-expanded={showOther}
        aria-keyshortcuts={choices.length < 9 ? String(choices.length + 1) : undefined}
        disabled={disabled}
        onClick={(e) => {
          e.currentTarget.focus();
          setOtherOpen(true);
        }}
      >
        <span className="iv-num" aria-hidden="true">{choices.length + 1}</span>
        {multi && <span className="iv-box" aria-hidden="true">{pick.other.trim() ? "✓" : ""}</span>}
        <span className="iv-body">
          <span className="iv-title">{t("card.other")}</span>
        </span>
      </button>
      {showOther && (
        <input
          ref={otherRef}
          className="card-in iv-in iv-other"
          value={pick.other}
          disabled={disabled}
          autoFocus={otherOpen && !pick.other}
          placeholder={multi ? t("card.otherMulti") : t("card.otherOne")}
          aria-label={t("card.otherN", { n: index + 1 })}
          onChange={(e) => onChange({ chosen: multi ? pick.chosen : [], other: e.target.value })}
          onBlur={() => {
            if (!pick.other.trim()) setOtherOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !pick.other) {
              e.stopPropagation();
              setOtherOpen(false);
            }
            if (e.key === "Enter" && onSubmitOther && !composing(e)) {
              e.preventDefault();
              onSubmitOther();
            }
          }}
        />
      )}
    </div>
  );
}

/** Several questions at once (Hermes' clarify with 2-5 questions): numbered, all answered with one Submit.
 *  Questions left blank go back as skipped. */
function Interview({ bot, item, cardRef }: { bot: string; item: ClarifyItem; cardRef: RefObject<HTMLFormElement | null> }) {
  const s = useStore();
  const qs = item.questions ?? [];
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const answers = (): ClarifyAnswers =>
    Object.fromEntries(qs.map((q) => [q.qid, answerOf(picks[q.qid] ?? EMPTY, !!q.multi_select && !!q.choices?.length)]));
  const given = Object.values(answers()).filter((v) => v !== null).length;

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    const a = answers();
    const e = await respond(getStore(), bot, item.id, () => s.respondClarify(item.request_id, a, bot));
    setErr(e);
    setBusy(false);
  };

  return (
    <form
      ref={cardRef}
      tabIndex={-1}
      className="card iv"
      onKeyDown={holdImeEnter}
      data-testid="card-interview"
      role="group"
      aria-label={t("card.questions", { n: qs.length })}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <AskedBy who={item.subagent} />
      <div className="card-title">{t("card.questions", { n: qs.length })}</div>
      <ol className="iv-list">
        {qs.map((q, i) => (
          <li key={q.qid} className="iv-q" data-testid="iv-question">
            <div className="iv-text">
              <span className="iv-n">{i + 1}</span>
              {q.question}
              {q.choices?.length ? <span className="iv-hint"> · {q.multi_select ? t("card.pickAny") : t("card.pickOne")}</span> : null}
            </div>
            <QuestionInput
              q={q}
              index={i}
              pick={picks[q.qid] ?? EMPTY}
              disabled={busy}
              onChange={(p) => setPicks((cur) => ({ ...cur, [q.qid]: p }))}
            />
          </li>
        ))}
      </ol>
      <div className="card-acts">
        <button type="submit" className="card-btn primary" disabled={busy}>
          {t("card.submit")}
        </button>
        <span className="iv-count" data-testid="iv-count">
          {t("card.answered", { given, n: qs.length })}
          {given < qs.length ? t("card.skipped", { n: qs.length - given }) : ""}
        </span>
        {err && <span className="card-err">{t("card.notSent", { error: err })}</span>}
      </div>
    </form>
  );
}

/** "Subagent · Write c.txt via echo asks": over a card raised inside a subagent, so the person knows who asks. */
function AskedBy({ who }: { who?: AskSubagent }) {
  if (!who) return null;
  return (
    <div className="card-who" data-testid="card-subagent" title={who.name}>
      {t("card.subagentAsks", { name: who.name || t("sub.untitled", { n: 1 }) })}
    </div>
  );
}

function Clarify({ bot, item }: { bot: string; item: ClarifyItem }) {
  const s = useStore();
  const open = useOpen(bot, item);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [pick, setPick] = useState<Pick>(EMPTY);
  const keys = useRef<QuestionKeys>(null);
  const ref = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const interview = (item.questions?.length ?? 0) > 1;
  useFocusRequest(bot, item.id, interview ? formRef : ref, open);

  const detail = interview ? t("card.questions", { n: item.questions!.length }) : item.question;
  const landed = useLanded(item.answer !== undefined);
  if (item.answer !== undefined) return <Line icon="✓" text={t("card.answeredWith", { answer: item.answer })} detail={detail} testid="card-line" landed={landed} ok />;
  if (item.expired && !busy) return <Line icon="–" text={t(EXPIRED_LABEL[item.expired])} detail={detail} testid="card-line" />;
  if (!open && !busy) return <Line icon="–" text={t("card.notAnswered")} detail={detail} testid="card-line" />;
  if (interview) return <Interview bot={bot} item={item} cardRef={formRef} />;

  const answer = async (a: string) => {
    if (!a.trim() || busy) return;
    setBusy(true);
    setErr(null);
    const e = await respond(getStore(), bot, item.id, () => s.respondClarify(item.request_id, a.trim(), bot));
    setErr(e);
    setBusy(false);
  };
  const choices = item.choices?.filter((c) => c.trim()) ?? [];
  const multi = !!item.multi && choices.length > 0;
  const q: ClarifyQuestion = { qid: "q", question: item.question, choices, multi_select: multi };
  const given = answerOf(pick, multi);

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="card"
      data-testid="card-clarify"
      role="group"
      aria-label={t("card.question")}
      onKeyDown={choices.length ? (e) => keys.current?.key(e) : undefined}
    >
      <AskedBy who={item.subagent} />
      <div className="card-title">{item.question}</div>
      {choices.length > 0 && (
        <QuestionInput
          q={q}
          index={0}
          pick={pick}
          disabled={busy}
          onChange={setPick}
          onPickOne={(c) => void answer(c)}
          onSubmitOther={() => void answer(multi ? given ?? "" : pick.other)}
          flat
          keys={keys}
        />
      )}
      <div className="card-acts">
        {choices.length > 0 ? (
          (multi || pick.other.trim()) && (
            <button type="button" className="card-btn primary" disabled={busy || given === null} onClick={() => void answer(given ?? "")}>
              {t("card.answer")}
            </button>
          )
        ) : (
          <form
            className="card-ask"
            onKeyDown={holdImeEnter}
            onSubmit={(e) => {
              e.preventDefault();
              void answer(text);
            }}
          >
            <input
              className="card-in"
              value={text}
              disabled={busy}
              placeholder={t("card.yourAnswer")}
              aria-label={t("card.yourAnswer")}
              onChange={(e) => setText(e.target.value)}
            />
            <button type="submit" className="card-btn primary" disabled={busy || !text.trim()}>
              {t("card.answer")}
            </button>
          </form>
        )}
        {err && <span className="card-err">{t("card.notSent", { error: err })}</span>}
      </div>
    </div>
  );
}

export default function Cards({ bot, item }: SlotProps["cards"]) {
  return item.kind === "approval" ? <Approval bot={bot} item={item} /> : <Clarify bot={bot} item={item} />;
}
