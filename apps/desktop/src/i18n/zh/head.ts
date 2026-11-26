import type { head as en } from "../en/head";

export const head: Record<keyof typeof en, string> = {
  "head.details": "详情（{key}）",
  "head.panel": "面板（{key}）",
  "head.panelLive1": "计划 · 1 个子代理正在工作（{key}）",
  "head.panelLive": "计划 · {n} 个子代理正在工作（{key}）",
};
