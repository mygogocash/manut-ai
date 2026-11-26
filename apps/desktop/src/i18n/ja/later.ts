import type { later as en } from "../en/later";

export const later: Record<keyof typeof en, string> = {
  "later.title": "上限のリセットを待っているメッセージ",
  "later.limit": "このアカウントは {when} まで上限に達しています。Enter でいま送ることもできます。",
  "later.limitFiles": "このアカウントは {when} まで上限に達しています。ファイル付きのメッセージは待たせられません。",
  "later.sendAt": "{when} に送る",
  "later.waiting": "{when} に送るまで待っています：",
  "later.waitingReady": "アカウントがまた使えるようになるのを待っています：",
  "later.late": "これは {since} から待っていました。いま送りますか？",
  "later.lateOf": "{name} へのメッセージが {since} から待っていました。いま送りますか？",
  "later.sendNow": "いま送る",
  "later.open": "開く",
  "later.cancel": "キャンセル",
  "later.aChat": "チャット",
};
