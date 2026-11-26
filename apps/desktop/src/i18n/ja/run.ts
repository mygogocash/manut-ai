import type { run as en } from "../en/run";

export const run: Record<keyof typeof en, string> = {
  // what keeps running: the commands this app's sessions started that still run (src/running/, on the Code page)
  "run.title": "実行し続けているコマンド",
  "run.tag": "実行中",
  "run.tag.preview": "プレビュー",
  "run.stop": "停止",
  "run.stopping": "停止しています",
  "run.stopAria": "{command} を停止",
  "run.stopFailed": "停止できませんでした。もう一度お試しください。",
  "run.none": "ここで始めたもので、実行中のものはありません。",
  "run.port": "ポート {ports}",
  "run.ports": "ポート {ports}",
  "run.unnamed": "コマンド",
  "run.others": "ほかのプロジェクトで {n} 件が実行中",
};
