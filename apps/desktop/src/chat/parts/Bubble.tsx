import { memo, type ReactNode } from "react";
import type { MessageItem } from "../../state/store";
import { Avatar, LiveRing, SourceIcon } from "../../ui";
import { Markdown } from "./Markdown";
import { MediaList } from "./Media";
import { splitMedia } from "./mediaLines";
import { SentFiles } from "./Attach";
import { SkillText } from "./Skills";
import { CopyButton } from "./Copy";
import { AgentChips } from "./AgentChip";
import { draftsAllowed, stripDrafts } from "./agentDraft";
import { t } from "../../i18n";
import { hhmm } from "../../app/time";
import { QueueMark, type QueueChoice, type QueueOffReasons } from "./QueueMark";
import type { Quote } from "./answers";
import { Icon } from "../../ui/icons";
import { splitSent } from "../box/carry";
import { readFromChat } from "../../jobs/reachList";
import { readFromProgram } from "../../threadsMcp/list";
import "../box/carry.css";

/** Messenger bubble, filled on both sides. Bot text renders markdown; user text stays plain. Files the bot
 * sent (`MEDIA:` lines) leave the text and show under it in the same column as the bubble, in order; while
 * streaming the lines are only hidden. Files the person sent sit under their own bubble, on the right.
 * Memoized: a store change elsewhere (a streamed token) must not re-render every bubble and its face. */
export const Bubble = memo(function Bubble({
  item,
  streaming,
  bot,
  face,
  faceEl,
  live,
  onEdit,
  editKeepsFiles,
  from,
  onQueue,
  queueBusy,
  queueOff,
  last,
  quote,
  onQuote,
  drawingsBy,
}: {
  item: Pick<MessageItem, "kind" | "text" | "error" | "reply" | "files" | "skills" | "wait" | "held" | "steered" | "readAt" | "steerReply" | "steerUnknown" | "steerUnused" | "autoSteer">;
  streaming?: boolean;
  /** The bot whose face sits beside its bubble; `face` false keeps the indent without repeating it. */
  bot?: string;
  face?: boolean;
  /** Drawn in the face column instead of the bot's picture (a SESSIONS chat's agent mark). */
  faceEl?: ReactNode;
  /** The answer being written: its face wears the live ring (the bot is still working). */
  live?: boolean;
  /** A user bubble the agent can take back (a SESSIONS chat's last message): its Edit control. */
  onEdit?: () => void;
  /** The turn Edit takes back changed files: a quiet line beside it says they stay as they are. */
  editKeepsFiles?: boolean;
  /** A user bubble someone else sent (a parent agent, in a read-only agent-to-agent chat): their small mark and name
   *  above it. */
  from?: ReactNode;
  /** A held message (steer queue): its ↵ mark's menu. */
  onQueue?: (c: QueueChoice) => void;
  /** Its steer is on the way: the mark waits. */
  queueBusy?: boolean;
  /** The person's last message in the chat: it carries the "Read" mark. */
  last?: boolean;
  /** Menu items that are off, with their reasons (a SESSIONS chat's agent). */
  queueOff?: QueueOffReasons;
  /** A bot answer: the message of the person's it replies to, when that is not plain from where it sits; a click
   *  scrolls to that message. */
  quote?: Quote | null;
  onQuote?: (id: string) => void;
  /** A chat's timeline: who its answers' drawings are by. A finished answer's html and svg blocks then offer Show
   *  drawing (src/chat/drawing/); a bubble anywhere else never does. */
  drawingsBy?: string;
}) {
  if (item.kind === "user") {
    // one being steered into the running answer reads as a plain sent message (messenger style), not a held one
    const held = !!item.held && !item.autoSteer;
    // a SESSIONS chat's waiting message carries the mark too (held by manut, or already with the agent)
    const marked = (held || item.wait === "queued" || !!item.steerUnknown) && !!onQueue;
    // copy the prompt, as typed (on hover; it takes no room). Not a held one: it is not sent yet, and its ↓ puts it
    // back in the box; one whose steer never answered may have reached the bot, so it has it (promptHistory.ts)
    const copy = item.text.trim() && !(held && !item.steerUnknown) && (
      <CopyButton className="msg-prompt" text={() => item.text} testId="copy-prompt" />
    );
    // messenger-style receipt: the bot has it (sent, its turn started, or the steer was queued). Under the last
    // message only, small and muted beside the bubble's bottom-left corner, as KakaoTalk shows time and read state
    const read = item.readAt !== undefined && last && (
      <span className="msg-read" data-testid="bubble-read">
        {item.readAt ? t("bub.readAt", { time: hhmm(new Date(item.readAt)) }) : t("bub.read")}
      </span>
    );
    return (
      <div
        className={`msg u${item.wait ? ` ${item.wait}` : ""}${held ? " held" : ""}`}
        data-testid="bubble-user"
        data-wait={item.wait}
        data-held={held || undefined}
        data-steered={item.steered || undefined}
      >
        {from && (
          <div className="msg-from" data-testid="bubble-from">
            {from}
          </div>
        )}
        {(item.text || !item.files?.length) &&
          (marked && onQueue ? (
            // a held message: its ↵ mark before the bubble, on the bubble's first line
            <div className="msg-line">
              {copy}
              <QueueMark onPick={onQueue} busy={queueBusy} off={queueOff} unknown={!!item.steerUnknown} />
              <div className="b">
                <SentText text={item.text} skills={item.skills} />
              </div>
            </div>
          ) : read ? (
            // the read mark beside the bubble's bottom edge; the copy button before it, so the two never overlap
            <div className="msg-line msg-line-read">
              <span className="msg-side">
                {copy}
                {read}
              </span>
              <div className="b">
                <SentText text={item.text} skills={item.skills} />
              </div>
            </div>
          ) : (
            <div className="b">
              <SentText text={item.text} skills={item.skills} />
              {copy}
            </div>
          ))}
        {item.files?.length ? <SentFiles files={item.files} /> : null}
        {item.reply && (
          <div className="msg-reply" data-testid="bubble-reply">
            {t("bub.replyTarget")} <SourceIcon source={item.reply.source} size={11} /> {item.reply.label}
          </div>
        )}
        {/* files only: the read mark goes under them */}
        {!(item.text || !item.files?.length) && read}
        {item.steered && item.steerReply && (
          <div className="msg-wait msg-steer-reply" data-testid="bubble-steer-reply">
            <span className="msg-steer-arrow" aria-hidden>
              ↳
            </span>
            {item.steerReply}
          </div>
        )}
        {item.steerUnknown && (
          <div className="msg-wait" data-testid="bubble-steer-unknown">
            {item.steerUnused ? t("sq.unused") : t("sq.unknown")}
          </div>
        )}
        {item.wait === "dropped" && (
          <div className="msg-wait" data-testid="bubble-dropped">
            {t("ctl.dropped")}
          </div>
        )}
        {item.error && <div className="msg-err">{t("bub.notSent", { error: item.error })}</div>}
        {onEdit && (
          <button type="button" className="msg-edit" onClick={onEdit} title={t("rw.tip")} data-testid="bubble-edit">
            {t("rw.edit")}
          </button>
        )}
        {onEdit && editKeepsFiles && (
          <div className="msg-edit-note" data-testid="bubble-edit-note">
            {t("rw.filesStay")}
          </div>
        )}
      </div>
    );
  }
  const { text, paths } = splitMedia(item.text);
  // a draft block shows only as its chip under the reply (where the chip can show); the chips still read `text`
  const shown = bot ? draftless(text, bot, !!streaming) : text;
  const faceNode =
    bot &&
    (faceEl ? (
      <span className={`msg-face${face === false ? " blank" : ""}`}>{faceEl}</span>
    ) : (
      <Avatar bot={bot} size={28} className={`msg-face${face === false ? " blank" : ""}`} />
    ));
  const body = (
    <div className={`msg a${streaming ? " streaming" : ""}${bot ? " face" : ""}`} data-testid={streaming ? "bubble-streaming" : "bubble-bot"}>
      {bot && live && face !== false ? (
        <LiveRing on size={28} gap={3} testId="face-ring" seed={bot}>
          {faceNode}
        </LiveRing>
      ) : (
        faceNode
      )}
      {/* one column beside the face: the caption, then the files under it, both on the bubble's left edge; a reply that
          was only a draft block shows its chip alone */}
      <div className="msg-col">
        {(shown || streaming || (paths.length === 0 && shown === text)) && (
          <div className="b md">
            {/* a drawing only once the answer is finished: never while it is written */}
            <Markdown text={shown} drawingsBy={streaming ? undefined : drawingsBy} />
            {/* copy the answer: beside the bubble's last line, on hover; it takes no room */}
            {!streaming && shown.trim() && <CopyButton className="msg-copy" text={() => shown} testId="copy-answer" />}
          </div>
        )}
        {bot && !streaming && paths.length > 0 && <MediaList bot={bot} paths={paths} />}
        {/* an `manut-agent` draft in a finished reply: its Add agent chip (main and folder chats only; `bot` is the chat) */}
        {bot && !streaming && <AgentChips chatKey={bot} text={text} />}
      </div>
    </div>
  );
  if (!quote) return body;
  // what this answer replies to, above it in the bubbles' column (the face stays beside the bubble): each message's
  // first line, a click brings that message into view
  return (
    <>
      <div className={`msg-quotes${bot ? " face" : ""}`} data-testid="bubble-quote">
        <span className="msg-quote-h" data-testid="bubble-quote-head">
          <Icon name="reply" />
          {t("bub.repliedTo", { n: quote.lines.length + quote.more })}
        </span>
        {quote.more > 0 && <span className="msg-quote-n">{t("bub.quoteMore", { n: quote.more })}</span>}
        {quote.lines.map((l) => (
          <button key={l.id} type="button" className="msg-quote" onClick={() => onQuote?.(l.id)} title={t("bub.quoteTip")} data-testid="bubble-quote-line">
            {l.text}
          </button>
        ))}
      </div>
      {body}
    </>
  );
});

/** The reply text the bubble shows: without the manut-agent blocks of a chat that turns them into chips. */
function draftless(text: string, chatKey: string, streaming: boolean): string {
  let out = text;
  if (draftsAllowed(chatKey)) out = stripDrafts(out, streaming);
  return out;
}

/** The person's own message: the notes it carried in front (item 97, chat/box/carry.ts) drawn as their quote with their note
 *  under it, another chat's context folded under its title, then what they typed. A message with none is the typed text. One that
 *  came from another chat (item 102k) says where from, above its words. */
function SentText({ text, skills }: { text: string; skills?: string[] }) {
  // a message that arrived from another chat on its card's Send there, or a lane's brief from Start lane (item 102k): the chat it
  // came from above its words, so it never reads as typed here
  const from = readFromChat(text);
  if (from) {
    return (
      <>
        <span className="msg-reached" data-testid="bubble-reached-from">
          <Icon name="link" size={12} />
          {t("reach.from", { title: from.title })}
        </span>
        <SkillText text={from.words} skills={skills} />
      </>
    );
  }
  // a message a program outside Manut AI asked to send and the person sent on (item 103c): the program above its words
  const program = readFromProgram(text);
  if (program) {
    return (
      <>
        <span className="msg-reached" data-testid="bubble-from-program">
          <Icon name="plug" size={12} />
          {t("tm.from", { name: program.name })}
        </span>
        <SkillText text={program.words} skills={skills} />
      </>
    );
  }
  const parts = splitSent(text);
  if (!parts.quotes.length && !parts.contexts.length) return <SkillText text={text} skills={skills} />;
  return (
    <>
      {parts.quotes.map((q, i) => (
        <blockquote key={`q${i}`} className="msg-carry" aria-label={t("carry.quoted")} data-testid="bubble-carry">
          <p className="msg-carry-q">{q.quote}</p>
          {q.note && (
            <p className="msg-carry-n" data-testid="bubble-carry-note">
              {q.note}
            </p>
          )}
        </blockquote>
      ))}
      {parts.contexts.map((c, i) => (
        <details key={`c${i}`} className="msg-ctx" data-testid="bubble-context">
          <summary>{c.title}</summary>
          <pre>{c.body}</pre>
        </details>
      ))}
      {parts.rest.trim() && <SkillText text={parts.rest} skills={skills} />}
    </>
  );
}
