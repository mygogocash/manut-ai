import type { risk as en } from "../en/risk";

export const risk: Record<keyof typeof en, string> = {
  "risk.delete": "ファイルとフォルダを削除します",
  "risk.admin": "管理者権限で実行します",
  "risk.force": "リモートブランチの履歴を書き換えます",
  "risk.discard": "ローカルの変更を破棄します",
  "risk.erase": "ディスクを消去します",
  "risk.rawDisk": "ディスクに直接書き込みます",
  "risk.perms": "権限を広範囲に変更します",
  "risk.db": "データベースのデータを削除します",
  "risk.pipe": "インターネットから取得したスクリプトを実行します",
  "risk.infra": "稼働中のインフラを削除します",
  "risk.forkBomb": "フォーク爆弾",
};
