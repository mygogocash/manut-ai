import type { pv as en } from "../en/pv";

export const pv: Record<keyof typeof en, string> = {
  "pv.loading": "読み込み中…",
  "pv.opened": "{cmd} でターミナルを開きました。そこでキーを入力してください。戻るとこの一覧が更新されます。",
  "pv.manual": "ターミナルで {cmd} を実行してください。",
  "pv.openFailed": "ターミナルを開けませんでした（{error}）。{cmd} を自分で実行してください。",
  "pv.addKey": "キーを追加",
  "pv.addKeyFor": "キーを追加する先",
  "pv.addApiKeyFor": "API キーを追加する先",
  "pv.setup": "Hermes で設定 · {cmd}",
  "pv.copyCmd": "コマンドをコピー",
  "pv.copy": "コピー",
  "pv.copied": "コピーしました",
  "pv.inUse": "使用中",
  "pv.addApiKey": "{name} の API キーを追加",
  "pv.filter": "{n} 個のモデルを絞り込む",
  "pv.filterOf": "{name} のモデルを絞り込む",
  "pv.noModels": "モデルなし",
  "pv.noMatch": "「{q}」に一致するモデルはありません",
  "pv.model1": "モデル 1 個",
  "pv.models": "モデル {n} 個",
};
