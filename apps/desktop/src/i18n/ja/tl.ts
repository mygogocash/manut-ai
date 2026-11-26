import type { tl as en } from "../en/tl";

export const tl: Record<keyof typeof en, string> = {
  "tl.offline": "{bot} は接続されていません。",
  "tl.loading": "読み込み中…",
  "tl.unreachable": "{bot} に接続できません（{error}）。少ししてからもう一度お試しください。",
  "tl.noModel": "{bot} にはまだモデルがありません。右上のモデルメニューから選んで始めてください。",
  "tl.jump": "いちばん下へ",
  "tl.jumpNew": "新着 {n} 件",
  "tl.pinnedOwn": "あなたのメッセージ: {text}",
  "tl.sayHi": "{bot} にあいさつしてみましょう",
};
