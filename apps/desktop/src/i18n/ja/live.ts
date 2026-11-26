import type { live as en } from "../en/live";

export const live: Record<keyof typeof en, string> = {
  "live.running": "実行中",
  "live.reading": "読み取り中",
  "live.searching": "検索中",
  "live.searchingWeb": "ウェブを検索中",
  "live.editing": "編集中",
  "live.asking": "依頼中",
  "live.usingSkill": "スキル使用中",
  "live.waitApproval": "対応が必要",
  "live.retrying": "再試行中 {n}/{max}",
  "live.waitAnswer": "回答待ち",
  "live.lost": "接続が切れました",
};
