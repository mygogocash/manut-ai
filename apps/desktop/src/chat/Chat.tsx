import "./chat.css";
import { selectAsks, useStore } from "../state/store";
import { Header } from "./parts/Header";
import { Timeline } from "./parts/Timeline";
import { Composer } from "./parts/Composer";
import { promptsOf } from "./parts/promptHistory";
import { t } from "../i18n";
import { can } from "../runtime";
import { ThreadChat } from "../threads/ThreadChat";

/** The selected bot's one main chat: header, timeline, composer. */
export function Chat() {
  const s = useStore();
  const bot = s.bots.find((b) => b.name === s.selectedBot) ?? null;
  if (!bot) {
    // no team member at all: one line that says so
    const none = s.conn === "open" && s.bots.length === 0;
    return (
      <div className="chat-empty" data-testid="chat-empty">
        {none ? (
          <span>{t("chat.noBotsHint")}</span>
        ) : s.conn === "open" ? (
          t("chat.pick")
        ) : (
          t("chat.connecting")
        )}
      </div>
    );
  }
  // a thread of this bot (sidebar tree): the same parts, fed by the thread's chat
  if (s.ui.thread) return <ThreadChat bot={bot} thread={s.ui.thread} />;
  const chat = s.chats[bot.name];
  const asking = selectAsks(s).some((a) => a.bot === bot.name);
  // the runtime is away (its adapter reconnects by itself): the composer says so and waits, like a bot that is offline
  const away = s.conn !== "open";
  return (
    <>
      <Header bot={bot} chat={chat} />
      <div className="pane" data-pane={bot.name}>
        <Timeline bot={bot} />
        <Composer
          key={bot.name}
          bot={bot}
          running={!!chat?.turn}
          asking={asking}
          offline={bot.status === "offline" || away}
          offlineText={away ? t("chat.connecting") : undefined}
          skills
          // the + menu lists a bot's plugins only when the runtime has any (and a Plugins page to manage them on)
          plugins={can("plugins")}
          history={promptsOf(chat?.items)}
          onSend={(text) => void s.send(text)}
          onSendFiles={(text, files) => s.sendWithFiles(text, files)}
          onStop={() => void s.interrupt()}
          reply={s.replyTo[bot.name] ?? null}
          onClearReply={() => s.setReplyTo(null, bot.name)}
          onNewThread={bot.host || bot.status === "offline" ? undefined : (first) => void s.newThreadWith(bot.name, first)}
        />
      </div>
    </>
  );
}
