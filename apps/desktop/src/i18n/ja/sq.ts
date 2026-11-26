import type { sq as en } from "../en/sq";

export const sq: Record<keyof typeof en, string> = {
  // steer queue
  "sq.sendNow": "今すぐ送信",
  "sq.sendNowTip": "今の回答を止めて、これを次に送ります",
  "sq.steer": "Steer",
  "sq.steerTip": "止めずに今の回答に渡します",
  "sq.edit": "編集",
  "sq.editTip": "入力欄に戻します",
  "sq.delete": "削除",
  "sq.deleteTip": "送信しません",
  "sq.unknown": "すでに回答に入っているかもしれません",
  "sq.unused": "使われませんでした · 回答が先に止まりました",
  "sq.send": "送信",
  "sq.sendTip": "新しいメッセージとして送信します",
};
