import type { mode as en } from "../en/mode";

export const mode: Record<keyof typeof en, string> = {
  "mode.practice": "練習モード",
  "mode.connected": "{host} に接続中",
  "mode.connecting": "{host} に接続しています…",
  "mode.signedOut": "サインアウト中 · {host}",
  "mode.offline": "オフライン · {host}",
  "mode.unavailable": "応答なし · {host}",
  "mode.cachedOffline": "オフライン。{time} 時点の内容を表示しています",
  "mode.cachedUnavailable": "応答なし。{time} 時点の内容を表示しています",
  "mode.oldOffline": "オフライン。保存したコピーは7日より古いため表示しません",
  "mode.oldUnavailable": "応答なし。保存したコピーは7日より古いため表示しません",
  "mode.unkeptOffline": "オフライン。このコンピューターはまだコピーを保存できないため、表示できる内容がありません",
  "mode.unkeptUnavailable": "応答なし。このコンピューターはまだコピーを保存できないため、表示できる内容がありません",
  "mode.open": "ランタイムの設定",
};
