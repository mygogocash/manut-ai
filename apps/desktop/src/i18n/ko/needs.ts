import type { needs as en } from "../en/needs";

export const needs: Record<keyof typeof en, string> = {
  // sidebar (the Needs-you list above BOTS)
  "needs.more": "+{n}개 더",
  "needs.one": "1개 확인 필요",
  "needs.many": "{n}개 확인 필요",
  "needs.list": "답을 기다리는 중",
  "needs.approve": "승인",
  "needs.question": "질문",
  "needs.emptyTitle": "확인할 일이 없어요",
  "needs.emptyText": "팀이 무언가를 보내거나, 돈을 쓰거나, 공개하려고 할 때는 먼저 여기서 물어봐요.",
  // Needs you says since when an ask waits; History's chips and kinds
  "needs.since": "{when}부터 기다리는 중",
};
