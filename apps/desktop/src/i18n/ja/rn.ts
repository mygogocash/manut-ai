import type { rn as en } from "../en/rn";

export const rn: Record<keyof typeof en, string> = {
  "rn.close": "ノードを閉じる",
  "rn.attempt": "試行 {n}/{total}",
  "rn.notStarted": "未開始",
  "rn.route": "ルート: {why}",
  "rn.why": "理由: ",
  "rn.open": "進行中",
  "rn.noHandoff": "引き継ぎは書かれていません。",
  "rn.ask": "チャットで依頼",
  "rn.askHint": "メッセージ欄に再試行の依頼を入れます。送信はしません。",
  "rn.chainHead": "chain head",
  "rn.fallback": "fallback",
  "rn.exhausted": "チェーンを使い切り",
  "rn.task": "タスク {n}",
  "rn.from": "（{from} から）",
  "rn.retryMsg": "実行 {run} の {node} を再試行して",
};
