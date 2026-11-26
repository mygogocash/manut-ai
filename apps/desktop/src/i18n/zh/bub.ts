import type { bub as en } from "../en/bub";

export const bub: Record<keyof typeof en, string> = {
  "bub.replyTarget": "回复目标",
  "bub.notSent": "未发送 · {error}",
  "bub.quoteTip": "查看这条回复对应的消息",
  "bub.quoteMore": "更早 {n} 条",
  "bub.repliedTo": "回复了你的 {n} 条消息",
  "bub.read": "已读",
  "bub.readAt": "已读 · {time}",
};
