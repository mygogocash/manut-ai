import type { sessions as en } from "../en/sessions";

export const sessions: Record<keyof typeof en, string> = {
  // sessions (SESSIONS in the sidebar)
  "sessions.choose": "フォルダを選択…",
  "sessions.recent": "最近",
  "sessions.back": "戻る",
  "sessions.new": "新しいチャットかターミナル",
  "sessions.home": "ホーム",
  "sessions.start": "開始",
  "sessions.agent": "エージェント",
  "sessions.folder": "フォルダ",
  "sessions.firstSend": "最初のメッセージで {agent} が {folder} で始まります",
  "sessions.firstStart": "開始を押すと {agent} が {folder} のターミナルで開きます",
  "sessions.pressStart": "開始を押すと {agent} がターミナルで開きます",
  "sessions.findingHome": "ホームフォルダを探しています…",
  "sessions.notInstalled": "未インストール",
};
