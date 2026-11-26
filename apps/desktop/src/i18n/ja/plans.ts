import type { plans as en } from "../en/plans";

export const plans: Record<keyof typeof en, string> = {
  // plans (the Plans tab: the list of a bot's runs)
  "plans.tab": "計画",
  "plans.of": "{bot}の計画",
  "plans.all": "全{n}件の計画",
  "plans.none": "計画はまだありません。",
  "plans.noneHint": "このボットが作業をサブエージェントに分けて任せると、各パートと進み具合がここにリアルタイムで表示されます。",
  "plans.noneHow": "始めるには、作業を並列に分けるよう頼むか、作業内容と一緒に {cmd} を送ってください。",
  "plans.noneHowHermes": "ボットが大きな仕事を部分に分けて計画するには oh-my-hermes が必要ですが、このコンピューターにはありません。ターミナルの + から追加できます。",
  "plans.stale": "{t}更新なし",
  "plans.cli": "CLI エージェント",
  "plans.cliAll": "CLI エージェント（{n}）",
  "plans.showAll": "すべて表示 ({n})",
  "plans.fewer": "折りたたむ",
  "plans.refresh": "更新",
  "plans.open": "計画 {name} を開く",
  "plans.graph": "計画グラフ",
  "plans.session": "このセッションのサブエージェント",
  "plans.sessionNone": "このセッションにはまだサブエージェントがありません。",
};
