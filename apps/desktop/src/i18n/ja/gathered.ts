import type { gathered as en } from "../en/gathered";

export const gathered: Record<keyof typeof en, string> = {
  // The gathered answers of a job (item 102c)
  "gathered.tab": "回答の集約 {n}/{total}",
  "gathered.count": "回答の集約: {total} 件中 {n} 件が回答済み",
  "gathered.compare": "チャットで比較…",
  "gathered.compareTip": "これらの回答をチャットの入力欄に入れます。送信はされません。そのチャットで送信を押すまで何も送られません。",
  "gathered.compareNeed": "比較には回答が 2 件必要です。",
  "gathered.answer": "答える",
  "gathered.waitingCount": "{n} 件があなたの返答を待っています",
  "gathered.laneLabel": "{agent} の回答",
  "gathered.waiting": "あなたの返答を待っています。ここまでの文章は回答として数えません。",
  "gathered.working": "作業中です。",
  "gathered.failed": "回答なしで止まりました。",
  "gathered.none": "まだ回答していません。",
  "gathered.files": "変更したファイル: {n}",
  "gathered.noFiles": "変更したファイルはありません",
  "gathered.filesMore": "ほか {n} 件",
  "gathered.tests": "テスト",
  "gathered.noTests": "テストは実行されていません",
  "gathered.put": "{title} の入力欄に回答 {n} 件を入れました。そのチャットで送信を押すまで何も送られません。",
  "gathered.open": "そのチャットを開く",
  "gathered.gone": "{title} はもうありません。",
};
