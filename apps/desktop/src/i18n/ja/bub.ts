import type { bub as en } from "../en/bub";

export const bub: Record<keyof typeof en, string> = {
  "bub.replyTarget": "返信先",
  "bub.notSent": "未送信 · {error}",
  "bub.quoteTip": "この返信の元のメッセージを表示",
  "bub.quoteMore": "以前の {n} 件",
  "bub.repliedTo": "あなたのメッセージ {n} 件に返信",
  "bub.read": "既読",
  "bub.readAt": "既読 · {time}",
};
