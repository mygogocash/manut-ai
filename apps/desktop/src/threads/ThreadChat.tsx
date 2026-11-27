// A thread of a bot in the main column: the bot's own header, timeline and composer, fed by the thread's chat
// (`fold:<bot>:<thread>`). Same Chat parts as the main chat; only where the words go differs.
import { asksIn, useStore } from "../state/store";
import type { Bot } from "../lib/protocol";
import { Timeline } from "../chat/parts/Timeline";
import { Composer } from "../chat/parts/Composer";
import { promptsOf } from "../chat/parts/promptHistory";
import { Avatar } from "../ui";
import { t } from "../i18n";
import { threadKey } from "./types";
import { kindWord } from "./kind";
import { rowStatus } from "./ThreadTree";
import { StatusGlyph } from "./StatusGlyph";
import { AgentBoxTools, pickFolder, teammates, useAgentBox } from "../chat/box/AgentBox";
import { chatScope } from "../chat/box/scope";
import { runtimeKind } from "../runtime";
import { BuddyMayReach } from "../jobs/MayReach";

export function ThreadChat({ bot, thread }: { bot: Bot; thread: string }) {
  const s = useStore();
  const key = threadKey(bot.name, thread);
  const chat = s.chats[key];
  const row = (s.threads[bot.name] ?? []).find((r) => r.thread === thread);
  const title = row?.title || t("thread.untitled");
  const away = s.conn !== "open";
  // a thread that answers through the person's own coding agent has the chat box's own choices, as its main chat does
  const box = useAgentBox(bot.name, thread);
  // the thread's chat stands in for a bot in the timeline and composer (its key, the bot's own picture and model)
  const as: Bot = { ...bot, name: key, model: chat?.model || bot.model, running: !!chat?.turn };
  return (
    <>
      <header className="head th-head" data-testid="thread-header">
        <button type="button" className="who-btn" onClick={() => void s.openThread(bot.name, null)} title={bot.display_name} data-testid="thread-back">
          <Avatar bot={bot.name} size={26} />
          <span className="head-title th-head-bot">{bot.display_name}</span>
        </button>
        <span className="th-head-sep" aria-hidden="true">
          /
        </span>
        {row && <StatusGlyph status={rowStatus(s, bot.name, row)} />}
        <span className="head-title th-head-title" data-testid="thread-title" title={title}>
          {title}
        </span>
        {/* a conversation with Buddy or the team's work, where the runtime lists both (Connected), so neither is taken for the other */}
        {row && kindWord(row.kind) && (
          <span className="th-head-kind" data-testid="thread-kind" data-kind={row.kind}>
            {kindWord(row.kind)}
          </span>
        )}
      </header>
      <div className="pane" data-pane={key} data-testid="thread-chat" data-thread={thread}>
        <Timeline
          bot={as}
          face={<Avatar bot={bot.name} size={28} />}
          connectionNotice={false}
          emptyHint={
            !chat?.turn && (
              <div className="th-empty" data-testid="thread-empty">
                {t("thread.newHint", { name: bot.display_name })}
              </div>
            )
          }
        />
        <Composer
          key={key}
          bot={as}
          running={!!chat?.turn}
          asking={asksIn(s, key).length > 0}
          history={promptsOf(chat?.items)}
          offline={bot.status === "offline" || away}
          offlineText={away ? t("chat.connecting") : undefined}
          onSend={(text, how) => void s.threadSend(bot.name, thread, text, how)}
          onStop={() => void s.threadInterrupt(bot.name, thread)}
          // `./thread` here opens a sibling thread under the same bot, as it does in the bot's main chat
          onNewThread={bot.host || bot.status === "offline" ? undefined : (first) => void s.newThreadWith(bot.name, first)}
          onSendFiles={box ? (text, files, how) => s.threadSendWithFiles(bot.name, thread, text, files, how) : undefined}
          // a thread answering through the person's own coding agent takes no message mid-answer, as its main chat
          steers={!box}
          tools={box ? <AgentBoxTools bot={bot.name} thread={thread} box={box} /> : undefined}
          onFolder={box ? pickFolder : undefined}
          mentions={box ? teammates(s.bots, bot.name) : undefined}
          actions={!!box}
          rows={!!box}
          voice={!!box}
          // a note or another chat's context made in this shop goes only to this shop's chats (item 97)
          scope={chatScope(key, s.shops.current, null, null)}
          // on Connected, the other conversations Buddy may ask to reach from this one, each only after a card (item 102l-3)
          foot={runtimeKind() === "http" ? <BuddyMayReach chatKey={key} /> : undefined}
        />
      </div>
    </>
  );
}
