import type { harness as en } from "../en/harness";

export const harness: Record<keyof typeof en, string> = {
  "harness.working": "作業中: {who}",
  "harness.trail": "現在の場所",
  "harness.openChat": "チャットで開く",
  "harness.closeChat": "プランに戻る",
  "harness.loading": "セッションを読み込み中…",
  "harness.error": "セッションを読めませんでした: {error}",
  "harness.none": "この部分のセッションはまだ見つかりません。",
  "harness.noCli": "{agent} がこの部分を担当しましたが、そのセッションはこのコンピュータにありません。",
  "harness.openChild": "{name} を開く",
  "harness.session": "セッション",
};
