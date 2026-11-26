import type { side as en } from "../en/side";

export const side: Record<keyof typeof en, string> = {
  "side.noBot": "「{q}」という名前のボットはありません",
  "side.noSession": "「{q}」に一致するセッションはありません",
  // spacing: the BOTS | TERMINALS divider
  "side.split": "ボットとターミナルの高さを変える",
  "side.splitTip": "ドラッグでボットかターミナルを広げます。ダブルクリックで自動に戻ります。",
};
