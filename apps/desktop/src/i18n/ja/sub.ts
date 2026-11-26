import type { sub as en } from "../en/sub";

export const sub: Record<keyof typeof en, string> = {
  "sub.queued": "待機",
  "sub.running": "実行中",
  "sub.thinking": "思考中",
  "sub.done": "完了",
  "sub.failed": "失敗",
  "sub.cancelled": "中断",
  "sub.stopped": "応答なし",
  "sub.waiting": "待機中",
  "sub.untitled": "サブエージェント {n}",
  "sub.runningDone": "実行中 · {n} 件中 {done} 件完了 · {t}",
  "sub.waitingDone": "待機中 · {n} 件中 {done} 件完了 · {t}",
  "sub.ran1": "サブエージェント1件を実行 · {t}",
  "sub.ranN": "サブエージェント{n}件を実行 · {t}",
  "sub.nfailed": "{n}件失敗",
};
