import type { head as en } from "../en/head";

export const head: Record<keyof typeof en, string> = {
  "head.details": "詳細（{key}）",
  "head.panel": "パネル（{key}）",
  "head.panelLive1": "計画 · サブエージェント1件が作業中（{key}）",
  "head.panelLive": "計画 · サブエージェント{n}件が作業中（{key}）",
};
