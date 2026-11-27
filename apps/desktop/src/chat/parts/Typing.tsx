import type { ReactNode } from "react";
import type { Chat } from "../../state/store";
import { answerSoFar, askOpen } from "../../state/store";
import { Avatar, LiveRing, TypingDots } from "../../ui";
import { t } from "../../i18n";

/** True while the bot works on an answer and nothing of it shows yet: a turn is running, no line of the answer
 *  shows, no answer of this turn landed, and the bot is not waiting on the person (an open card says that instead).
 *  Tool steps do not end it: the dots stay, the activity line under them, until the answer starts, so the person
 *  always sees the bot is still writing (owner's ask, messenger style). */
export function awaitingFirstToken(chat: Chat | undefined): boolean {
  const t = chat?.turn;
  // text being written ends the typing bubble only once a whole line of it can show (answerSoFar)
  if (!t || answerSoFar(t)) return false;
  const since = t.startedAt / 1000;
  for (const i of chat.items) {
    if (i.kind === "assistant" && i.ts >= since) return false;
    if ((i.kind === "approval" || i.kind === "clarify") && askOpen(chat.items, i)) return false;
  }
  return true;
}

/** True while the person's newest message is on its way to a runtime that answers it before its request ends (`answersOnSend`:
 *  Connected's chat), so the member is writing though no turn says so: the message is the last thing in the chat, it went from
 *  this app in this run (a message read back from history is never on its way), and it is not read, refused or held. It ends
 *  with the answer's turn, or with a refusal, which marks the message not sent: no turn started, so nothing failed. */
export function answeringOnSend(chat: Chat | undefined): boolean {
  if (!chat || chat.turn) return false;
  const last = chat.items[chat.items.length - 1];
  return !!last && last.kind === "user" && last.id.startsWith("local-") && last.readAt === undefined && !last.error && !last.held;
}

/** The bot's 28px face in the live ring (`face`: a SESSIONS chat's agent mark instead of the picture). One of
 *  these sits in the live run while the bot works: beside the typing bubble, then the activity line, then the
 *  streaming answer (liveFaceRow). */
export function LiveFace({ bot, face, testId = "face-ring" }: { bot: string; face?: ReactNode; testId?: string }) {
  return (
    <LiveRing on size={28} gap={3} testId={testId} seed={bot}>
      {face ?? <Avatar bot={bot} size={28} className="msg-face" />}
    </LiveRing>
  );
}

/** The bot's face with the live ring and a typing bubble beside it, until the answer starts; the live activity
 *  line, when there is one, sits under it. Face 28px + 10px gap: the same column as the face beside bot bubbles. */
export function TypingRow({ bot, name, face }: { bot: string; name: string; face?: ReactNode }) {
  return (
    <div className="msg a typing" data-testid="typing" role="status" aria-label={t("ty.writing", { name })}>
      <LiveFace bot={bot} face={face} testId="typing-ring" />
      <div className="b" data-testid="typing-bubble">
        <TypingDots size={6} />
      </div>
    </div>
  );
}
