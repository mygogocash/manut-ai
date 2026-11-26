import type { chat as en } from "../en/chat";

export const chat: Record<keyof typeof en, string> = {
  // chat (the chat column's own words)
  "chat.noBotsHint": "아직 사용할 수 있는 봇이 없어요.",
  "chat.pick": "봇을 선택하세요",
  "chat.connecting": "연결하는 중…",
};
