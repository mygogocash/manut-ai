import type { bub as en } from "../en/bub";

export const bub: Record<keyof typeof en, string> = {
  "bub.replyTarget": "답장 대상",
  "bub.notSent": "보내지 못함 · {error}",
  "bub.quoteTip": "이 답장의 원래 메시지 보기",
  "bub.quoteMore": "이전 {n}개 더",
  "bub.repliedTo": "내 메시지 {n}개에 답장",
  "bub.read": "읽음",
  "bub.readAt": "읽음 · {time}",
};
