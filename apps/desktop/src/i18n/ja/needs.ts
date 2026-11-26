import type { needs as en } from "../en/needs";

export const needs: Record<keyof typeof en, string> = {
  // sidebar (the Needs-you list above BOTS)
  "needs.more": "+{n} 件",
  "needs.one": "1 件の確認待ち",
  "needs.many": "{n} 件の確認待ち",
  "needs.list": "回答待ち",
  "needs.approve": "承認",
  "needs.question": "質問",
  "needs.emptyTitle": "対応が必要なものはありません",
  "needs.emptyText": "チームが送信、支払い、公開をしようとするときは、まずここで確認します。",
  // Needs you says since when an ask waits; History's chips and kinds
  "needs.since": "{when}から待機中",
};
