import type { pull as en } from "../en/pull";

export const pull: Record<keyof typeof en, string> = {
  "pull.why.pulled": "{branch} を {remote} に合わせて最新にしました：新しいコミット {n} 件（{from} から {to}）。",
  "pull.why.pulledOne": "{branch} を {remote} に合わせて最新にしました：新しいコミット 1 件（{from} から {to}）。",
  "pull.why.current": "{branch} は {remote} と同じく最新です。",
  "pull.why.git_missing": "プルしませんでした：git がこのコンピュータにありません。",
  "pull.why.config": "プルしませんでした：このプロジェクト自身の git 設定が、git に実行させるプログラムか、別の取得先を指定しています（{setting}）。アプリはそれを自分からは実行しません。信頼できる場合はターミナルでプルしてください。",
  "pull.why.busy": "{branch} をプルしませんでした：このフォルダーで git が作業の途中です。",
  "pull.why.detached": "プルしませんでした：このフォルダーはどのブランチにもありません。",
  "pull.why.no_upstream": "{branch} をプルしませんでした：リモートのブランチを追跡していません。",
  "pull.why.not_default": "プルしませんでした：このフォルダーはリモートのデフォルトブランチではなく {branch} にあります。",
  "pull.why.unread": "{branch} をプルしませんでした：フォルダーの中身を git が読み取れませんでした。",
  "pull.why.changes": "{branch} をプルしませんでした：フォルダーに変更されたファイルか新しいファイルがあります。",
  "pull.why.submodules": "{branch} をプルしませんでした：このプロジェクトにはサブモジュールがあり、アプリはその中を自動では見ません。ターミナルでプルしてください。",
  "pull.why.ahead": "{branch} をプルしませんでした：まだリモートにないコミットがあります。",
  "pull.why.fetch_failed": "{branch} をプルしませんでした：パスワードなしで 10 秒以内に {remote} に接続できませんでした。",
  "pull.why.diverged": "{branch} をプルしませんでした：こちらと {remote} の両方が進んでいるため、そのまま前に進められません。",
  "pull.why.failed": "{branch} をプルしませんでした：git が前に進めるのを拒否しました。",
};
