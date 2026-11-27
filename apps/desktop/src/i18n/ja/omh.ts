import type { omh as en } from "../en/omh";

export const omh: Record<keyof typeof en, string> = {
  // onboarding (the first-run cards and the empty sections' lines)
  "omh.add.line": "oh-my-hermes を追加",
  "omh.add.tip": "Manut AI の初回画面と同じインストーラーを実行します。その後、ボットが大きな仕事を部分に分けて計画し、Plans に表示します。",
  "omh.add.exit": "インストーラーが停止しました（exit {code}）。",
  "omh.icon": "oh-my-hermes がインストールされていません",
  "omh.pop.body": "入れると、ボットが大きな仕事を部分に分けて計画して割り振り、その計画が進む様子を Plans で見られます。",
  "omh.pop.hide": "今後表示しない",
};
