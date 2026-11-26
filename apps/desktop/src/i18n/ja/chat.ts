import type { chat as en } from "../en/chat";

export const chat: Record<keyof typeof en, string> = {
  // chat (the chat column's own words)
  "chat.noBotsHint": "まだ利用できるボットがありません。",
  "chat.pick": "ボットを選択してください",
  "chat.connecting": "接続中…",
};
