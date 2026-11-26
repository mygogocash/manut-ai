import type { upd as en } from "../en/upd";

export const upd: Record<keyof typeof en, string> = {
  "upd.tip": "Manut AI {version} をインストールして再起動",
  "upd.retry": "アップデートを再試行",
  "upd.to": "{version} にアップデート",
  "upd.failed": "アップデートに失敗しました",
  "upd.restarting": "再起動中…",
  "upd.updating": "アップデート中…",
  "upd.updatingPct": "アップデート中 {n}%",
};
