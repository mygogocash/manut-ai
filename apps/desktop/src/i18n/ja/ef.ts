import type { ef as en } from "../en/ef";

export const ef: Record<keyof typeof en, string> = {
  // the effort card (item 132): the chip while it is open, the card's title with no levels, its buttons and the slider
  "ef.select": "考える深さを選択",
  "ef.standard": "標準",
  "ef.none": "このモデルには選べる考える深さがありません。",
  "ef.reset": "既定に戻す",
  "ef.chooseModel": "モデルを選ぶ",
  "ef.selectModel": "モデルを選択",
  "ef.back": "戻る",
  "ef.slider": "考える深さ",
  // the one-click Ultrathink row, Claude Code chats only: a visible line in the draft
  "ef.utTitle": "このメッセージを Ultrathink",
  "ef.utAdds": "このメッセージの先頭に「Ultrathink:」を加え、Claude Code にもっとじっくり考えてもらいます。",
  "ef.utTyped": "オフにするには、メッセージから「ultrathink」を消してください。",
  "ef.utSlash": "Claude Code はスラッシュコマンドの中の ultrathink を読みません。",
};
