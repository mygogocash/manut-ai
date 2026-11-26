import type { nav as en } from "../en/nav";

export const nav: Record<keyof typeof en, string> = {
  // sidebar nav (the foot of the sidebar) and its search
  "nav.automations": "ルーティン",
  "nav.plugins": "スキルとツール",
  "nav.settings": "設定",
  "nav.search": "検索",
  "nav.searchBots": "ボットとターミナルを検索",
  "nav.addBot": "ボットを追加",
  "nav.bots": "チーム",
  "nav.sessions": "セッション",
  "nav.you": "自分",
  "nav.accounts": "アカウント",
  // termui: TERMINALS (terminal sessions) and the sidebar dock
  "nav.terminals": "ターミナル",
};
