import type { chat as en } from "../en/chat";

export const chat: Record<keyof typeof en, string> = {
  // chat (the chat column's own words)
  "chat.noBotsHint": "还没有可用的机器人。",
  "chat.pick": "选择一个机器人",
  "chat.connecting": "正在连接…",
};
