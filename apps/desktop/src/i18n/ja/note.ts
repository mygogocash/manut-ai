import type { note as en } from "../en/note";

export const note: Record<keyof typeof en, string> = {
  "note.approval": "{bot} が承認を待っています",
  "note.mayHoldKey": "キーを含む可能性のあるコマンドです。Manut AI を開いて確認してください。",
  "note.question": "{bot} から質問があります",
  "note.error": "{bot} がエラーで停止しました",
  "note.failed": "ターンが失敗しました。",
  "note.session.ended": "{name} のセッションが終了しました",
  "note.session.endedBody": "プログラムが終了しました。",
  "note.session.failed": "{name} のセッションを開始できませんでした",
  "note.session.bell": "{name} のセッションが確認を待っています",
  "note.session.bellBody": "ターミナルのベルを鳴らしました。",
  "note.waiting": "あなたを待っています。",
  "note.watchMany": "{bot}: ウォッチ通知 {n} 件",
  "note.atShop": "{shop} の {bot}",
};
