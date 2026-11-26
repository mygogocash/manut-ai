import type { history as en } from "../en/history";

export const history: Record<keyof typeof en, string> = {
  "history.find": "履歴を検索",
  "history.findPh": "タイトルと最新メッセージを検索",
  "history.emptyTitle": "まだ履歴はありません",
  "history.emptyText": "Buddy やチームとのスレッドが、新しい順にここに表示されます。",
  "history.none": "「{q}」に一致するスレッドはありません",
  // where a job's page and the activity log are opened from
  "history.kind.job": "仕事",
  "history.show": "表示",
  "history.lane.all": "すべて",
  "history.archive": "アーカイブ",
  "history.archiveN": "アーカイブ ({n})",
};
