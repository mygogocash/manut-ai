import type { cmp as en } from "../en/cmp";

export const cmp: Record<keyof typeof en, string> = {
  "cmp.skillHint": "{bot} のスキル一覧がありません。先頭に名前をすべて入力します。例: {example}",
  "cmp.skillSigil": "スキルはメッセージのどこでも $ で入力します。例: {example}。/ コマンドはそのまま {bot} に送られます。",
  "cmp.removeReply": "返信先を外す",
  "cmp.remove": "外す",
  "cmp.offline": "{bot} はオフラインです",
  "cmp.replyThere": "そこに投稿する内容を {bot} に伝えてください",
  "cmp.asking": "上で回答するか、入力して返信",
  "cmp.message": "{bot} にメッセージ",
  "cmp.stop": "停止",
  "cmp.send": "送信",
};
