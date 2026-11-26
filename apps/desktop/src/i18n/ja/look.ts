import type { look as en } from "../en/look";

export const look: Record<keyof typeof en, string> = {
  "look.theme": "テーマ",
  "look.themeHint": "「システム」はコンピュータの設定に従います",
  "look.system": "システム",
  "look.dark": "ダーク",
  "look.light": "ライト",
  "look.bubbles": "吹き出し",
  "look.soft": "ソフト",
  "look.solid": "ソリッド",
  "look.open": "オープン",
  "look.softHint": "両側とも淡い色の吹き出し",
  "look.solidHint": "自分のメッセージをアクセントカラーで",
  "look.openHint": "ボットはページに直接書き、自分だけが吹き出しに入ります",
  "look.size": "文字サイズ",
  "look.sizeHint": "メッセージと入力欄",
  "look.small": "小",
  "look.medium": "中",
  "look.large": "大",
  "look.pvAsk": "502 エラーを見てもらえる？",
  "look.pvAnswer": "原因が分かりました。{path} の keep-alive 接続が切れていました。詳しくは{link}にあります。",
  "look.pvLink": "ランブック",
};
