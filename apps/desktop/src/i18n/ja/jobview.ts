import type { jobview as en } from "../en/jobview";

export const jobview: Record<keyof typeof en, string> = {
  // The job's side-by-side view (item 102b)
  "jobview.back": "レーン一覧に戻る",
  "jobview.tabs": "このジョブのエージェント",
  "jobview.openLane": "レーンを開く",
  "jobview.stop": "停止",
  "jobview.stopAll": "すべて停止",
  "jobview.stopAllAsk": "作業中の {n} つのエージェントをすべて停止しますか？",
  "jobview.keep": "続ける",
  "jobview.again": "もう一度頼む",
  "jobview.againTip": "同じエージェントと同じメッセージで「複数のエージェントに頼む」を開きます。送信を押すまで何も送られません。",
  "jobview.nothingRuns": "このレーンでは何も動いていません。",
  "jobview.chatLabel": "{agent} のレーン",
  "jobview.openTip": "このジョブのエージェントを並べて見る",
  "jobview.none": "このジョブにはレーンが残っていません。",
};
