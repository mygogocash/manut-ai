import "./chat.css";
import { asksIn, useStore } from "../state/store";
import { Header } from "./parts/Header";
import { Timeline } from "./parts/Timeline";
import { Composer } from "./parts/Composer";
import { promptsOf } from "./parts/promptHistory";
import { t } from "../i18n";
import { can } from "../runtime";
import { ThreadChat } from "../threads/ThreadChat";
import { AgentBoxTools, pickFolder, teammates, useAgentBox } from "./box/AgentBox";
import { slots } from "../features";
import { chatScope } from "./box/scope";

/** The selected bot's one main chat: header, timeline, composer. A chat that answers through the person's own coding
 *  agent (Buddy in Practice) has the chat box's own choices (item 80): the model and its effort and the approval level
 *  in the box, and Add context names a folder, a teammate or an action too. Any other member's model and reasoning are
 *  in the box as well (item 85f): the header names no model, as the Chat board's does not. */
export function Chat() {
  const s = useStore();
  const bot = s.bots.find((b) => b.name === s.selectedBot) ?? null;
  const box = useAgentBox(bot && !s.ui.thread ? bot.name : null);
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
  const asking = asksIn(s, bot.name).length > 0;
  // the runtime is away (its adapter reconnects by itself): the composer says so and waits, like a bot that is offline
  const away = s.conn !== "open";
  const Picker = slots.modelPicker;
  return (
    <>
      <Header bot={bot} />
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
          onSend={(text, how) => void s.send(text, how)}
          onSendFiles={(text, files, how) => s.sendWithFiles(text, files, how)}
          // Buddy's own coding agent takes no message mid-answer (buddy_chat.rs refuses a steer); a member's chat does
          steers={!box}
          onStop={() => void s.interrupt()}
          reply={s.replyTo[bot.name] ?? null}
          onClearReply={() => s.setReplyTo(null, bot.name)}
          onNewThread={bot.host || bot.status === "offline" ? undefined : (first) => void s.newThreadWith(bot.name, first)}
          // a member with no box of its own (once the runtime said so, so Buddy's box does not flash a second model first)
          tools={box ? <AgentBoxTools bot={bot.name} box={box} /> : Picker && s.agentBox[bot.name] === null ? <Picker bot={bot} chat={chat} inBox /> : undefined}
          onFolder={box ? pickFolder : undefined}
          mentions={box ? teammates(s.bots, bot.name) : undefined}
          actions={!!box}
          rows={!!box}
          voice={!!box}
          // a note or another chat's context made in this shop goes only to this shop's chats (item 97)
          scope={chatScope(bot.name, s.shops.current, null, null)}
        />
      </div>
    </>
  );
}
