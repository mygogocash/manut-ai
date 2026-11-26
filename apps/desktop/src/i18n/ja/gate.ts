import type { gate as en } from "../en/gate";

export const gate: Record<keyof typeof en, string> = {
  "gate.failedHead": "インストールが完了しませんでした",
  "gate.head": "Hermes をインストールして始めましょう",
  "gate.text": "ボットは Hermes Agent 上で動きますが、このコンピュータにはまだありません。インストールすると下のコマンドで Hermes、続いて oh-my-hermes を入れます。",
  "gate.copyCmd": "コマンドをコピー",
  "gate.copy": "コピー",
  "gate.copied": "コピーしました",
  "gate.couldNotRun": "インストーラーを実行できませんでした。",
  "gate.stopped": "インストーラーが停止しました（exit {code}）。理由は上の出力にあります。直してからもう一度インストールを押してください。",
  "gate.installing": "インストール中…",
  "gate.again": "もう一度インストール",
  "gate.install": "インストール",
  "gate.check": "再確認",
  "gate.note": "数分かかります。モデルはそのあとアプリで選びます。",
  "gate.unreachable": "Manut AI が Hermes に接続できません",
  "gate.starting": "Manut AI を起動中…",
  "gate.noBridge": "ローカルブリッジが起動しませんでした。",
  "gate.retry": "再試行",
  "gate.reviving": "ブリッジを再起動しています…",
};
