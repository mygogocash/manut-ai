import type { update as en } from "../en/update";

export const update: Record<keyof typeof en, string> = {
  // while it answers (Settings › General)
  // update (the sidebar's Update button and its confirm) and resume after a restart
  "update.title": "{version} にアップデートしますか？",
  "update.body": "Manut AI が再起動します。チャット、パネル、セッションは中断したところから続きます。",
  "update.running1": "実行中のセッション 1 件: {list}。",
  "update.runningN": "実行中のセッション {n} 件: {list}。",
  "update.thenAuto1": "再起動後に続きから再開します。",
  "update.thenAuto": "再起動後に続きから再開します。",
  "update.thenManual1": "再起動後は「再開」ボタンで戻せます。",
  "update.thenManual": "再起動後は「再開」ボタンで戻せます。",
  "update.thenMixed": "Claude Code、Codex、OmO は自動で再開し、その他は「再開」ボタンで戻せます。",
  "update.cancel": "キャンセル",
  "update.confirm": "アップデートして再起動",
};
