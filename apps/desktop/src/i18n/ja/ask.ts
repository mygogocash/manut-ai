import type { ask as en } from "../en/ask";

export const ask: Record<keyof typeof en, string> = {
  // the "say it in words" box on Automations and Plugins
  "ask.to": "{bot} に送る",
  "ask.pickBot": "ボットを選ぶ",
  "ask.send": "{bot} のチャットに送信",
  "ask.offline": "{bot} はオフラインです。ゲートウェイを起動してからもう一度お試しください。",
  "ask.allowCmd": "{cmd} を許可しますか？",
  "ask.allowThis": "このコマンドを許可しますか？",
  "ask.questions": "質問 {n} 件: {first}",
  "ask.sessionEnded": "このセッションは終了しました",
};
