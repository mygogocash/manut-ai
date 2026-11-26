import type { head as en } from "../en/head";

export const head: Record<keyof typeof en, string> = {
  "head.details": "상세 ({key})",
  "head.panel": "패널 ({key})",
  "head.panelLive1": "계획 · 서브에이전트 1개 작업 중 ({key})",
  "head.panelLive": "계획 · 서브에이전트 {n}개 작업 중 ({key})",
};
