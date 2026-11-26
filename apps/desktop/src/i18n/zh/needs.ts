import type { needs as en } from "../en/needs";

export const needs: Record<keyof typeof en, string> = {
  // sidebar (the Needs-you list above BOTS)
  "needs.more": "+{n} 项",
  "needs.one": "1 项待你处理",
  "needs.many": "{n} 项待你处理",
  "needs.list": "等待你的回复",
  "needs.approve": "审批",
  "needs.question": "提问",
  "needs.emptyTitle": "没有需要你处理的事",
  "needs.emptyText": "团队要发送、付款或公开发布内容时，会先在这里问你。",
  // Needs you says since when an ask waits; History's chips and kinds
  "needs.since": "自 {when} 起等待",
};
